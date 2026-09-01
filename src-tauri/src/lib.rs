mod data;
mod classifier;
mod live;
mod burnin;
mod plugins;

use data::{
    parse_osm_line, recordings_dir, now_secs, CsvRecorder, SessionIndex, SessionRecord,
    SampleValidator, MAX_CHANNELS,
};
use data::osmell::{
    phase_color, phase_instruction, phase_label,
    OsmellRecorder, PhaseSnapshot,
};

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, State};
use std::thread;

use opensmell::{
    AdaptiveAnomalyDetector, FailSafeSystem, LabelingSystem, PoisoningDetector,
    DetectionResult, AccuracyImprovement, DetectorState, LabelingStats,
    FailSafeResult, LabelRecord, SensorHealthConfig,
    protocol::{OsmProtocol, OsmMessage},
};

pub struct AppState {
    pub detector: Arc<Mutex<AdaptiveAnomalyDetector>>,
    pub fail_safe: Arc<Mutex<FailSafeSystem>>,
    pub labeling: Arc<Mutex<LabelingSystem>>,
    pub poisoning: Arc<Mutex<PoisoningDetector>>,
    pub serial_connected: Arc<Mutex<bool>>,
    pub serial_port_name: Arc<Mutex<Option<String>>>,
    pub baud_rate: Arc<Mutex<u32>>,
    pub channel_count: Arc<Mutex<usize>>,
    pub current_readings: Arc<Mutex<Vec<Vec<f64>>>>,
    pub session_start: Arc<Mutex<Option<f64>>>,
    pub session_recording: Arc<Mutex<bool>>,
    pub recorder: Arc<Mutex<Option<CsvRecorder>>>,
    pub phase_recorder: Arc<Mutex<Option<OsmellRecorder>>>,
    pub recordings_dir: Arc<Mutex<std::path::PathBuf>>,
    pub session_index: Arc<Mutex<SessionIndex>>,
    pub wifi_connected: Arc<Mutex<bool>>,
    pub wifi_host: Arc<Mutex<Option<String>>>,
    pub ble_connected: Arc<Mutex<bool>>,
    pub ble_device_address: Arc<Mutex<Option<String>>>,
    pub oled_config: Arc<Mutex<OledConfig>>,
    pub buzzer_config: Arc<Mutex<BuzzerConfig>>,
    pub fleet: Arc<Mutex<Vec<FleetDeviceState>>>,
    pub last_channels: Arc<Mutex<Vec<f64>>>,
    pub live_classifier: Arc<Mutex<opensmell::LiveClassifier>>,
}

impl Default for AppState {
    fn default() -> Self {
        let n = 6;
        let rec_dir = recordings_dir();
        Self {
            detector: Arc::new(Mutex::new(AdaptiveAnomalyDetector::new(n, 0.05))),
            fail_safe: Arc::new(Mutex::new(FailSafeSystem::new(n))),
            labeling: Arc::new(Mutex::new(LabelingSystem::new())),
            poisoning: Arc::new(Mutex::new(PoisoningDetector::new(n, SensorHealthConfig::default()))),
            serial_connected: Arc::new(Mutex::new(false)),
            serial_port_name: Arc::new(Mutex::new(None)),
            baud_rate: Arc::new(Mutex::new(data::DEFAULT_BAUD)),
            channel_count: Arc::new(Mutex::new(MAX_CHANNELS)),
            current_readings: Arc::new(Mutex::new(Vec::new())),
            session_start: Arc::new(Mutex::new(None)),
            session_recording: Arc::new(Mutex::new(false)),
            recorder: Arc::new(Mutex::new(None)),
            phase_recorder: Arc::new(Mutex::new(None)),
            recordings_dir: Arc::new(Mutex::new(rec_dir.clone())),
            session_index: Arc::new(Mutex::new(SessionIndex::load(&rec_dir))),
            wifi_connected: Arc::new(Mutex::new(false)),
            wifi_host: Arc::new(Mutex::new(None)),
            ble_connected: Arc::new(Mutex::new(false)),
            ble_device_address: Arc::new(Mutex::new(None)),
            oled_config: Arc::new(Mutex::new(OledConfig::default())),
            buzzer_config: Arc::new(Mutex::new(BuzzerConfig::default())),
            fleet: Arc::new(Mutex::new(Vec::new())),
            last_channels: Arc::new(Mutex::new(Vec::new())),
            live_classifier: Arc::new(Mutex::new(opensmell::LiveClassifier::new())),
        }
    }
}

// === Serial ===

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let mut ports = Vec::new();
    if let Ok(serial_ports) = serialport::available_ports() {
        for p in serial_ports {
            // Only surface USB & Bluetooth serial devices — actual connectable
            // e-nose candidates. Onboard legacy UARTs (ttyS* exposed as
            // PciPort/Unknown) are not real devices and just add noise.
            let (kind, desc) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let board = classify_vid_pid(info.vid, info.pid);
                    let kind = if board == "esp32" {
                        "osmograph-e-nose".to_string()
                    } else if board != "unknown" {
                        board
                    } else {
                        "unknown-usb".to_string()
                    };
                    (kind, info.product.clone().unwrap_or_default())
                }
                serialport::SerialPortType::BluetoothPort => {
                    ("bluetooth".to_string(), String::new())
                }
                _ => continue,
            };
            ports.push(SerialPortInfo {
                name: p.port_name.clone(),
                description: desc,
                kind,
                hw_type: format!("{:?}", p.port_type),
            });
        }
    }
    Ok(ports)
}

#[derive(Serialize, Deserialize)]
pub struct SerialPortInfo {
    pub name: String,
    pub description: String,
    /// Label from classify_vid_pid: "osmograph-e-nose" (recognised ESP32),
    /// or "arduino_uno"/"raspberry_pi_pico"/"unknown-usb".
    pub kind: String,
    pub hw_type: String,
}

/// Process a single line from a data connection (serial or WiFi).
///
/// Matches the Python reader semantics: lenient OSM parsing (drop non-numeric
/// tokens, require >= 3 values), per-sample DataValidator gating, bootloader
/// line detection, and rich INFO/CAL/ERR/PING handling as a desktop extra.
fn handle_reader_line(
    line: &str,
    protocol: &OsmProtocol,
    expected_channels: usize,
    validator: &mut SampleValidator,
    app: &tauri::AppHandle,
    last_channels: &Arc<Mutex<Vec<f64>>>,
) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }

    if SampleValidator::is_bootloader_line(line) {
        let _ = app.emit("bootloader-detected", line.to_string());
    }

    let now = now_secs();

    let mut emit_data = |channels: Vec<f64>| {
        if let Some(valid) = validator.validate(&channels) {
            if let Ok(mut last) = last_channels.lock() {
                *last = valid.clone();
            }
            let _ = app.emit("serial-data", SerialDataEvent {
                channels: valid,
                timestamp: now,
                raw_line: line.to_string(),
            });
        }
    };

    match protocol.parse_line(line, now) {
        Ok(OsmMessage::Data { channels, .. }) => {
            emit_data(channels);
        }
        Ok(OsmMessage::Info { device_id, firmware_version, n_sensors }) => {
            let _ = app.emit("serial-info", SerialInfoEvent {
                device_id,
                firmware_version,
                n_sensors,
            });
        }
        Ok(OsmMessage::Calibration { channel, r0_value }) => {
            let _ = app.emit("serial-cal", SerialCalEvent { channel, r0_value });
        }
        Ok(OsmMessage::Error { code, message }) => {
            let _ = app.emit("serial-error", SerialErrorEvent { code, message });
        }
        Ok(OsmMessage::Ping) => {}
        Ok(OsmMessage::Unknown(_)) => {
            if let Some(channels) = parse_osm_line(line, expected_channels) {
                emit_data(channels);
            }
        }
        Err(_) => {
            // Strict parse failed; fall back to the Python-style lenient parse.
            if let Some(channels) = parse_osm_line(line, expected_channels) {
                emit_data(channels);
            }
        }
    }
}

#[tauri::command]
fn connect_serial(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    port: String,
    baud_rate: u32,
    n_channels: usize,
) -> Result<String, String> {
    {
        let connected = state.serial_connected.lock().map_err(|e| e.to_string())?;
        if *connected {
            return Err("Already connected. Disconnect first.".to_string());
        }
    }

    let port_handle = serialport::new(&port, baud_rate)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| {
            match e.kind() {
                serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
                    "Permission denied. Add your user to the 'dialout' group:\n  sudo usermod -a -G dialout $USER\nThen log out and back in.".to_string()
                }
                serialport::ErrorKind::Io(std::io::ErrorKind::NotFound) => {
                    format!("Port {} not found. Is the device plugged in and in work mode (not bootloader)?", port)
                }
                _ => format!("Failed to open {}: {}", port, e),
            }
        })?;

    *state.serial_port_name.lock().map_err(|e| e.to_string())? = Some(port.clone());
    *state.baud_rate.lock().map_err(|e| e.to_string())? = baud_rate;
    *state.channel_count.lock().map_err(|e| e.to_string())? = n_channels.max(1);
    *state.serial_connected.lock().map_err(|e| e.to_string())? = true;
    state.current_readings.lock().map_err(|e| e.to_string())?.clear();

    let connected_flag = state.serial_connected.clone();
    let last_channels = state.last_channels.clone();
    let app_handle = app.clone();

    thread::spawn(move || {
        let mut reader = port_handle;
        let protocol = OsmProtocol::new(MAX_CHANNELS);
        let mut validator = SampleValidator::new();
        let mut bootloader_newlines = 0usize;
        let mut buffer: Vec<u8> = Vec::with_capacity(1024);
        let mut chunk = [0u8; 512];

        loop {
            if !*connected_flag.lock().unwrap() {
                break;
            }
            match reader.read(&mut chunk) {
                Ok(0) => break, // EOF — port is gone.
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(e) => {
                    // A read timeout is NOT a disconnect — it just means the device
                    // paused for a moment (Python's reader treats it the same way:
                    // `if not raw: time.sleep(0.01); continue`). Only break on a real
                    // I/O error (device unplugged, port closed).
                    match e.kind() {
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => continue,
                        _ => break,
                    }
                }
            }

            // Drain every complete newline-terminated line; keep the trailing
            // partial line in `buffer` so a line split across reads is never lost.
            let mut handled = 0usize;
            while let Some(rel) = buffer[handled..].iter().position(|&b| b == b'\n') {
                let end = handled + rel + 1;
                // Python counts newlines since connect; <5 => still bootloader output.
                bootloader_newlines += buffer[handled..end]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count();
                if bootloader_newlines < 5 {
                    let _ = app_handle.emit("bootloader-detected", String::new());
                }
                let line = String::from_utf8_lossy(&buffer[handled..end]);
                handle_reader_line(
                    &line,
                    &protocol,
                    MAX_CHANNELS,
                    &mut validator,
                    &app_handle,
                    &last_channels,
                );
                handled = end;
            }
            if handled > 0 {
                buffer.drain(..handled);
            } else if buffer.len() > 8192 {
                // Guard against unbounded growth from a binary/garble stream with
                // no newlines (e.g. a magstripe-style bootloader dump).
                buffer.drain(..4096);
            }
        }

        *connected_flag.lock().unwrap() = false;
        let _ = app_handle.emit("serial-disconnected", ());
    });

    Ok(format!("Connected to {} at {} baud, {} channels", port, baud_rate, n_channels))
}

#[derive(Clone, Serialize)]
struct SerialDataEvent {
    channels: Vec<f64>,
    timestamp: f64,
    raw_line: String,
}

#[derive(Clone, Serialize)]
struct SerialInfoEvent {
    device_id: String,
    firmware_version: String,
    n_sensors: usize,
}

#[derive(Clone, Serialize)]
struct SerialCalEvent {
    channel: usize,
    r0_value: f64,
}

#[derive(Clone, Serialize)]
struct SerialErrorEvent {
    code: i32,
    message: String,
}

#[tauri::command]
fn disconnect_serial(state: State<'_, AppState>) -> Result<String, String> {
    *state.serial_connected.lock().map_err(|e| e.to_string())? = false;
    *state.serial_port_name.lock().map_err(|e| e.to_string())? = None;
    Ok("Disconnected".to_string())
}

#[tauri::command]
fn get_serial_status(state: State<AppState>) -> Result<SerialStatus, String> {
    let connected = state.serial_connected.lock().map_err(|e| e.to_string())?;
    let port = state.serial_port_name.lock().map_err(|e| e.to_string())?;
    let baud = state.baud_rate.lock().map_err(|e| e.to_string())?;
    let n_ch = state.channel_count.lock().map_err(|e| e.to_string())?;
    let last = state.last_channels.lock().map_err(|e| e.to_string())?;
    Ok(SerialStatus {
        connected: *connected,
        port: port.clone().unwrap_or_default(),
        baud_rate: *baud,
        channel_count: *n_ch,
        last_channels: last.clone(),
    })
}

#[derive(Serialize, Deserialize)]
pub struct SerialStatus {
    pub connected: bool,
    pub port: String,
    pub baud_rate: u32,
    pub channel_count: usize,
    pub last_channels: Vec<f64>,
}

// === Board detection (mirrors Python `board/detector.py`) ===

#[derive(Serialize, Deserialize, Clone)]
pub struct BoardReport {
    pub board_type: String,
    pub port: String,
    pub vid_pid: String,
    pub serial_number: String,
    pub manufacturer: String,
    pub label: String,
    pub is_known: bool,
}

fn board_label(board_type: &str) -> &'static str {
    match board_type {
        "esp32" => "ESP32",
        "arduino_uno" => "Arduino Uno",
        "raspberry_pi_pico" => "Raspberry Pi Pico",
        _ => "Unknown Board",
    }
}

/// Classify a USB serial port by VID:PID (parity with `board/detector.py::VID_PID_MAP`).
fn classify_vid_pid(vid: u16, pid: u16) -> String {
    match (vid, pid) {
        (0x10C4, 0xEA60) => "esp32".to_string(), // CP2102
        (0x1A86, 0x7523) => "esp32".to_string(), // CH340
        (0x10C4, 0xEA70) => "esp32".to_string(), // CP2105
        (0x2E8A, 0x0005) => "raspberry_pi_pico".to_string(),
        (0x2341, 0x0043) => "arduino_uno".to_string(),
        (0x2341, 0x0001) => "arduino_uno".to_string(),
        (0x303A, 0x0002) => "esp32".to_string(), // ESP32-S2/S3 (desktop extra)
        (0x303A, 0x1001) => "esp32".to_string(), // ESP32-S3 native USB
        _ => "unknown".to_string(),
    }
}

/// List connected boards, mirroring `BoardDetector.detect()` plus the Rust hint
/// for ESP32-S2/S3 VID 0x303A. Returns one report per USB serial port.
#[tauri::command]
fn detect_board() -> Result<Vec<BoardReport>, String> {
    Ok(serial_port_reports())
}

/// Non-command helper: enumerate USB serial ports into BoardReport structs.
fn serial_port_reports() -> Vec<BoardReport> {
    let mut boards = Vec::new();
    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            if let serialport::SerialPortType::UsbPort(info) = p.port_type {
                let board_type = classify_vid_pid(info.vid, info.pid);
                boards.push(BoardReport {
                    board_type: board_type.clone(),
                    port: p.port_name,
                    vid_pid: format!("{:04x}:{:04x}", info.vid, info.pid),
                    serial_number: info.serial_number.unwrap_or_default(),
                    manufacturer: info.manufacturer.unwrap_or_default(),
                    is_known: board_type != "unknown",
                    label: board_label(&board_type).to_string(),
                });
            }
        }
    }
    boards
}

/// Build a labelled fleet entry for a serial port, classifying it by VID:PID.
///
/// Only USB & Bluetooth serial devices are returned (connectable e-nose
/// candidates). Onboard legacy UARTs (ttyS* → PciPort/Unknown) are skipped so
/// a scan doesn't flood the fleet with 30+ non-devices. Unknown USB devices are
/// still listed (never hidden) so DIY/indie e-nose builders are not locked out —
/// they're just clearly marked as not-yet-recognised.
fn serial_fleet_entry(index: usize, name: &str, description: &str) -> Option<FleetDeviceState> {
    let mut kind = "unknown-usb".to_string();
    let mut is_recognized = false;
    let mut n_channels = 6usize;
    let mut found = false;

    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            if p.port_name != name {
                continue;
            }
            found = true;
            match p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let board = classify_vid_pid(info.vid, info.pid);
                    if board == "esp32" {
                        kind = "osmograph-e-nose".to_string();
                        is_recognized = true;
                        n_channels = 6;
                    } else if board != "unknown" {
                        kind = board; // e.g. arduino_uno / raspberry_pi_pico
                        is_recognized = false;
                    } else {
                        kind = "unknown-usb".to_string();
                        is_recognized = false;
                    }
                }
                serialport::SerialPortType::BluetoothPort => {
                    kind = "bluetooth".to_string();
                    is_recognized = false;
                }
                // Onboard PCI/unknown UARTs (ttyS*) are not real connectable
                // devices — filter them out of the fleet scan.
                _ => return None,
            }
            break;
        }
    }

    if !found {
        return None;
    }

    Some(FleetDeviceState {
        id: format!("device-{}", index),
        name: if description.is_empty() {
            format!("Serial /dev {}", name)
        } else {
            description.to_string()
        },
        status: "offline".to_string(),
        port: name.to_string(),
        n_channels,
        firmware_version: "unknown".to_string(),
        uptime_seconds: 0.0,
        ip: String::new(),
        kind,
        is_recognized,
        sensors: default_sensors(n_channels),
    })
}

#[derive(Serialize, Deserialize)]
pub struct FlashToolchain {
    pub platformio: bool,
    pub arduino_cli: bool,
    pub esptool: bool,
    pub message: String,
}

fn command_exists(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Report which ESP32 flashing toolchains are available on this machine.
#[tauri::command]
fn check_flash_toolchain() -> Result<FlashToolchain, String> {
    let platformio = command_exists("pio");
    let arduino_cli = command_exists("arduino-cli");
    let esptool = command_exists("esptool");
    let message = if platformio {
        "PlatformIO (pio) available".to_string()
    } else if arduino_cli {
        "Arduino CLI available".to_string()
    } else if esptool {
        "esptool available but no compiler toolchain. Install PlatformIO or arduino-cli to rebuild firmware.".to_string()
    } else {
        "No ESP32 toolchain found. Install PlatformIO (pip install platformio) or arduino-cli, then retry.".to_string()
    };
    Ok(FlashToolchain { platformio, arduino_cli, esptool, message })
}

fn sensor_pins_for(n_channels: usize) -> Vec<u8> {
    match n_channels {
        3 => vec![32, 33, 34],
        4 => vec![32, 33, 34, 35],
        _ => vec![32, 33, 34, 35, 25, 26],
    }
}

fn channels_for(preset: &str) -> usize {
    match preset {
        "3-sensor-food" => 3,
        "4-sensor-food" => 4,
        "3-sensor-safety" => 3,
        "4-sensor-safety" => 4,
        _ => 6,
    }
}

fn run_upload(last: Result<std::process::Output, std::io::Error>, tool: &str, port: &str, preset: &str, n_channels: usize) -> Result<String, String> {
    match last {
        Ok(o) => {
            if o.status.success() {
                Ok(format!("Firmware '{}' flashed to {} ({} channels) via {}", preset, port, n_channels, tool))
            } else {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let stdout = String::from_utf8_lossy(&o.stdout);
                Err(format!("Flash failed ({}): {}{}", tool, stdout, stderr))
            }
        }
        Err(e) => Err(format!("Failed to run {}: {}", tool, e)),
    }
}

/// Generate, compile (if possible), and flash the OpenSmell ESP32 firmware.
///
/// The firmware advertises mDNS `_osmograph._tcp` on port 8080 (TCP OSM protocol).
/// Uses PlatformIO if available, else Arduino CLI; reports install hints otherwise.
/// Empty `wifi_ssid`/`wifi_password` produce a board that boots into SoftAP mode.
#[tauri::command]
fn flash_firmware(
    port: String,
    preset: String,
    wifi_ssid: String,
    wifi_password: String,
) -> Result<String, String> {
    let n_channels = channels_for(&preset);
    let sensor_pins = sensor_pins_for(n_channels);
    let sketch = opensmell::protocol::generate_arduino_sketch(&sensor_pins, &wifi_ssid, &wifi_password);

    let temp_dir = std::env::temp_dir().join("osmograph_firmware");
    let _ = std::fs::create_dir_all(&temp_dir);

    // PlatformIO project layout
    let pio_dir = temp_dir.join("pio");
    let _ = std::fs::create_dir_all(pio_dir.join("src"));
    std::fs::write(pio_dir.join("platformio.ini"), format!(
        "[env:esp32]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\nupload_speed = 921600\n"
    )).map_err(|e| format!("Failed to write platformio.ini: {}", e))?;
    std::fs::write(pio_dir.join("src").join("main.cpp"), &sketch)
        .map_err(|e| format!("Failed to write main.cpp: {}", e))?;

    // Arduino CLI project layout (sketch must live in a folder with its own name)
    let ino_dir = temp_dir.join("osmograph_firmware");
    let _ = std::fs::create_dir_all(&ino_dir);
    std::fs::write(ino_dir.join("osmograph_firmware.ino"), &sketch)
        .map_err(|e| format!("Failed to write .ino: {}", e))?;

    if command_exists("pio") {
        let out = std::process::Command::new("pio")
            .args(["run", "-t", "upload", "--upload-port", &port])
            .current_dir(&pio_dir)
            .output();
        return run_upload(out, "PlatformIO", &port, &preset, n_channels);
    }

    if command_exists("arduino-cli") {
        let build_dir = temp_dir.join("build");
        let _ = std::fs::create_dir_all(&build_dir);
        let ino = ino_dir.to_str().ok_or_else(|| "Temp path invalid".to_string())?;
        let out_dir = build_dir.to_str().ok_or_else(|| "Temp path invalid".to_string())?;
        let compile = std::process::Command::new("arduino-cli")
            .args(["compile", "--fqbn", "esp32:esp32:esp32", "--output-dir", out_dir, ino])
            .output()
            .map_err(|e| format!("Failed to run arduino-cli: {}", e))?;
        if !compile.status.success() {
            let stderr = String::from_utf8_lossy(&compile.stderr);
            return Err(format!(
                "Compile failed. Is the esp32 core installed? Try: arduino-cli core install esp32:esp32\n{}",
                stderr
            ));
        }
        let upload = std::process::Command::new("arduino-cli")
            .args(["upload", "-p", &port, "--fqbn", "esp32:esp32:esp32", ino])
            .output();
        return run_upload(upload, "arduino-cli", &port, &preset, n_channels);
    }

    Err("No ESP32 flashing toolchain found. Install PlatformIO (pip install platformio) or Arduino CLI (arduino-cli core install esp32:esp32).".to_string())
}

// === esptool device operations (mirrors Python `board/flasher.py`) ===

fn esptool_cmd() -> String {
    if command_exists("esptool.py") {
        "esptool.py".to_string()
    } else if command_exists("esptool") {
        "esptool".to_string()
    } else {
        "esptool.py".to_string()
    }
}

fn esptool_available() -> bool {
    command_exists("esptool") || command_exists("esptool.py") || command_exists("python3")
}

fn run_esptool(args: &[&str]) -> Result<(bool, String), String> {
    let cmd = esptool_cmd();
    let output = std::process::Command::new(&cmd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run esptool ({}): {}", cmd, e))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok((output.status.success(), text))
}

/// Erase the entire flash of a connected ESP32 (parity: `FlashingService.erase_flash`).
#[tauri::command]
fn erase_flash(port: String, chip: Option<String>) -> Result<String, String> {
    if !esptool_available() {
        return Err("esptool not found. Install with: pip install esptool".to_string());
    }
    let chip = chip.unwrap_or_else(|| "esp32".to_string());
    match run_esptool(&["--chip", &chip, "--port", &port, "erase_flash"])? {
        (true, _) => Ok(format!("Flash erased on {}", port)),
        (false, out) => Err(format!("Erase failed: {}", out)),
    }
}

/// Read the base MAC address of the connected ESP32 (parity: `FlashingService.read_mac`).
#[tauri::command]
fn read_mac(port: String, chip: Option<String>) -> Result<String, String> {
    if !esptool_available() {
        return Err("esptool not found. Install with: pip install esptool".to_string());
    }
    let chip = chip.unwrap_or_else(|| "esp32".to_string());
    let (ok, out) = run_esptool(&["--chip", &chip, "--port", &port, "read_mac"])?;
    if !ok {
        return Err(format!("read_mac failed: {}", out));
    }
    for line in out.lines() {
        if line.to_uppercase().contains("MAC") {
            return Ok(line.trim().to_string());
        }
    }
    Err("No MAC line in esptool output".to_string())
}

// === Detection ===

#[tauri::command]
fn ingest_reading(state: State<AppState>, reading: Vec<f64>) -> Result<DetectionResult, String> {
    {
        let mut readings = state.current_readings.lock().map_err(|e| e.to_string())?;
        readings.push(reading.clone());
        if readings.len() > 10000 { readings.remove(0); }
    }
    let detector = state.detector.lock().map_err(|e| e.to_string())?;
    detector.detect(&reading).map_err(|e| e.to_string())
}

#[tauri::command]
fn ingest_reading_with_failsafe(
    state: State<AppState>,
    app: tauri::AppHandle,
    reading: Vec<f64>,
) -> Result<FailSafeResult, String> {
    {
        let mut readings = state.current_readings.lock().map_err(|e| e.to_string())?;
        readings.push(reading.clone());
        if readings.len() > 10000 { readings.remove(0); }
    }

    // Sole recorder feed point: live (serial/WiFi) and demo samples all converge
    // here through the frontend, so the phase/.osmell and CSV recorders see both.
    {
        let mut rec = state.recorder.lock().map_err(|e| e.to_string())?;
        if let Some(r) = rec.as_mut() {
            r.write_sample(&reading);
        }
    }
    {
        let mut rec = state.phase_recorder.lock().map_err(|e| e.to_string())?;
        if let Some(r) = rec.as_mut() {
            r.write_sample(&reading);
        }
    }

    {
        let mut poisoning = state.poisoning.lock().map_err(|e| e.to_string())?;
        for (ch, &val) in reading.iter().enumerate() {
            let _ = poisoning.update_channel(ch, &[val]);
        }
    }

    // Live classifier feed (mirrors `RealtimeClassifier.add_sample`): every
    // validated sample enters the rolling window; a prediction is emitted once
    // the buffer fills (and periodically while streams continue).
    {
        let mut live = state.live_classifier.lock().map_err(|e| e.to_string())?;
        if live.add_sample(&reading).is_some() {
            let snapshot = live.snapshot();
            let _ = app.emit("live-classification", snapshot);
        }
    }

    let mut fail_safe = state.fail_safe.lock().map_err(|e| e.to_string())?;
    fail_safe.detect(&reading).map_err(|e| e.to_string())
}

// === User Feedback ===

#[tauri::command]
fn label_sample(state: State<AppState>, reading: Vec<f64>, is_anomaly: bool, note: String) -> Result<LabelRecord, String> {
    {
        let mut detector = state.detector.lock().map_err(|e| e.to_string())?;
        detector.update_with_feedback(&reading, is_anomaly, &note).map_err(|e| e.to_string())?;
    }
    {
        let mut fail_safe = state.fail_safe.lock().map_err(|e| e.to_string())?;
        fail_safe.update_feedback(&reading, is_anomaly, &note).map_err(|e| e.to_string())?;
    }
    let mut labeling = state.labeling.lock().map_err(|e| e.to_string())?;
    Ok(labeling.label_sample(&reading, is_anomaly, &note, 1.0))
}

#[tauri::command]
fn get_labeling_stats(state: State<AppState>) -> Result<LabelingStats, String> {
    let labeling = state.labeling.lock().map_err(|e| e.to_string())?;
    Ok(labeling.get_statistics())
}

#[tauri::command]
fn get_detector_state(state: State<AppState>) -> Result<DetectorState, String> {
    let detector = state.detector.lock().map_err(|e| e.to_string())?;
    Ok(detector.export_state())
}

#[tauri::command]
fn get_learning_progress(state: State<AppState>) -> Result<AccuracyImprovement, String> {
    let detector = state.detector.lock().map_err(|e| e.to_string())?;
    Ok(detector.get_accuracy_improvement())
}

#[tauri::command]
fn calibrate_baseline(state: State<AppState>, samples: Vec<Vec<f64>>) -> Result<String, String> {
    let mut detector = state.detector.lock().map_err(|e| e.to_string())?;
    detector.calibrate_baseline(&samples).map_err(|e| e.to_string())?;
    Ok(format!("Calibrated with {} samples", samples.len()))
}

// === Session ===

#[tauri::command]
fn start_session(
    state: State<'_, AppState>,
    label: Option<String>,
    duration_sec: Option<f64>,
) -> Result<String, String> {
    let now = now_secs();
    {
        let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
        if let Some(r) = recorder.as_ref() {
            if r.is_recording() {
                return Err("Already recording a session".to_string());
            }
        }
        if let Some(label) = label {
            if !label.trim().is_empty() {
                let save_dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
                let n = *state.channel_count.lock().map_err(|e| e.to_string())?;
                let mut rec = CsvRecorder::new(save_dir);
                rec.start(&label, duration_sec.unwrap_or(0.0), n)
                    .map_err(|e| e.to_string())?;
                *recorder = Some(rec);
            }
        }
    }
    *state.session_start.lock().map_err(|e| e.to_string())? = Some(now);
    *state.session_recording.lock().map_err(|e| e.to_string())? = true;
    state.current_readings.lock().map_err(|e| e.to_string())?.clear();
    Ok(format!("Session started at {}", now))
}

#[tauri::command]
fn stop_session(state: State<'_, AppState>) -> Result<SessionSummary, String> {
    let start = state.session_start.lock().map_err(|e| e.to_string())?.take();
    *state.session_recording.lock().map_err(|e| e.to_string())? = false;
    let duration = start
        .map(|s| now_secs() - s)
        .unwrap_or(0.0);

    let mut substance = String::from("unknown");
    let mut record_path: Option<String> = None;
    let mut sensor_count = 0usize;
    {
        let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
        if let Some(rec) = recorder.as_mut() {
            if rec.is_recording() {
                substance = rec.label().to_string();
                sensor_count = 0;
                if let Some(p) = rec.stop() {
                    record_path = Some(p.to_string_lossy().to_string());
                }
            }
        }
    }

    let n_readings = state.current_readings.lock().map_err(|e| e.to_string())?.len();
    let quality_score = SessionIndex::provision_quality(duration, n_readings);

    let mut file_id = None;
    if let Some(path) = record_path.clone() {
        if std::path::Path::new(&path).exists() {
            let now_local = chrono::Local::now();
            let fid = SessionIndex::make_file_id(now_local);
            let preset = current_preset_name(&state);
            let record = SessionRecord {
                file_id: fid.clone(),
                substance: substance.clone(),
                label: "Recorded".to_string(),
                csv_path: path.clone(),
                timestamp: now_secs(),
                duration_sec: duration,
                sensor_count,
                preset_name: preset,
                notes: String::new(),
                opensmell_result: None,
                quality_report: None,
                quality: quality_score,
            };
            let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
            {
                let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
                index.upsert(record);
                let _ = index.save(&dir);
            }
            file_id = Some(fid);
        }
    }

    Ok(SessionSummary {
        duration_seconds: duration,
        n_readings,
        start_time: start.unwrap_or(0.0),
        record_path,
        file_id,
        substance,
        quality_score,
    })
}

// === Phase Recording (.osmell) ===

#[derive(Serialize, Deserialize)]
pub struct PhaseRecorderState {
    pub active: bool,
    pub label: String,
    pub current_phase: String,
    pub current_phase_label: String,
    pub current_phase_color: String,
    pub current_phase_instruction: String,
    pub phase_elapsed: f64,
    pub phase_duration: f64,
    pub phase_progress: f64,
    pub total_elapsed: f64,
    pub total_duration: f64,
    pub total_progress: f64,
    pub phases: Vec<PhaseSnapshot>,
    pub saved_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct PhaseRecordingSummary {
    pub label: String,
    pub path: Option<String>,
    pub file_id: Option<String>,
    pub total_duration: f64,
    pub n_samples: usize,
    pub quality_score: f64,
    pub phases: Vec<PhaseSnapshot>,
}

fn phase_recorder_state(rec: &OsmellRecorder) -> PhaseRecorderState {
    let phase = rec.current_phase().unwrap_or("");
    PhaseRecorderState {
        active: rec.is_recording(),
        label: rec.label().to_string(),
        current_phase: phase.to_string(),
        current_phase_label: phase_label(phase).to_string(),
        current_phase_color: phase_color(phase).to_string(),
        current_phase_instruction: phase_instruction(phase).to_string(),
        phase_elapsed: rec.current_phase_elapsed(),
        phase_duration: rec.current_phase_duration(),
        phase_progress: rec.phase_progress(),
        total_elapsed: rec.total_elapsed(),
        total_duration: rec.total_duration(),
        total_progress: rec.total_progress(),
        phases: rec.phase_snapshots(),
        saved_path: rec.file_path().map(|p| p.to_string_lossy().to_string()),
    }
}

/// Begin a before/during/after phase recording (Python `OsmellRecorder.start`).
#[tauri::command]
fn start_phase_recording(
    state: State<'_, AppState>,
    substance: Option<String>,
    baseline_sec: Option<f64>,
    exposure_sec: Option<f64>,
    recovery_sec: Option<f64>,
    preset_name: Option<String>,
) -> Result<PhaseRecorderState, String> {
    let label = substance.unwrap_or_default();
    if label.trim().is_empty() {
        return Err("Substance name required".to_string());
    }

    {
        let slot = state.phase_recorder.lock().map_err(|e| e.to_string())?;
        if let Some(rec) = slot.as_ref() {
            if rec.is_recording() {
                return Err("A phase recording is already active".to_string());
            }
        }
    }

    let save_dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let n = *state.channel_count.lock().map_err(|e| e.to_string())?;
    let preset = preset_name
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Some(current_preset_name(&state)))
        .unwrap_or_default();

    let mut rec = OsmellRecorder::new(save_dir);
    rec.configure(
        baseline_sec.unwrap_or(data::osmell::DEFAULT_BASELINE_SEC),
        exposure_sec.unwrap_or(data::osmell::DEFAULT_EXPOSURE_SEC),
        recovery_sec.unwrap_or(data::osmell::DEFAULT_RECOVERY_SEC),
        n,
        &preset,
    );
    rec.start(&label);
    let snapshot = phase_recorder_state(&rec);
    let mut slot = state.phase_recorder.lock().map_err(|e| e.to_string())?;
    *slot = Some(rec);
    Ok(snapshot)
}

/// Force-finish early, or settle a naturally-completed recording. In both
/// cases the `.osmell` (or CSV fallback) path is indexed in the library.
#[tauri::command]
fn stop_phase_recording(state: State<AppState>) -> Result<PhaseRecordingSummary, String> {
    let mut slot = state.phase_recorder.lock().map_err(|e| e.to_string())?;
    let rec = match slot.as_mut() {
        Some(r) => r,
        None => return Err("No phase recording active".to_string()),
    };

    let label = rec.label().to_string();
    let snapshots = rec.phase_snapshots();
    if rec.is_recording() {
        rec.stop_and_save();
    }
    let path = rec.file_path().map(|p| p.to_string_lossy().to_string());
    let n_samples: usize = rec.phase_snapshots().iter().map(|p| p.sample_count).sum();
    let total_duration = rec.total_elapsed();
    let quality_score = SessionIndex::provision_quality(total_duration, n_samples);

    // Index the recording in the persistent library (`.osmell` path).
    let mut file_id = None;
    if let Some(p) = path.clone() {
        if std::path::Path::new(&p).exists() {
            let fid = SessionIndex::make_file_id(chrono::Local::now());
            let record = SessionRecord {
                file_id: fid.clone(),
                substance: label.clone(),
                label: "Recorded".to_string(),
                csv_path: p.clone(),
                timestamp: now_secs(),
                duration_sec: total_duration,
                sensor_count: 0,
                preset_name: rec.preset_name().to_string(),
                notes: String::new(),
                opensmell_result: None,
                quality_report: None,
                quality: quality_score,
            };
            let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
            let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
            index.upsert(record);
            let _ = index.save(&dir);
            file_id = Some(fid);
        }
    }

    *slot = None;
    Ok(PhaseRecordingSummary {
        label,
        path,
        file_id,
        total_duration,
        n_samples,
        quality_score,
        phases: snapshots,
    })
}

/// Abort a phase recording without saving.
#[tauri::command]
fn cancel_phase_recording(state: State<AppState>) -> Result<(), String> {
    let mut slot = state.phase_recorder.lock().map_err(|e| e.to_string())?;
    if let Some(rec) = slot.as_mut() {
        rec.cancel();
    }
    *slot = None;
    Ok(())
}

/// Poll the recorder; advances phases on the wall-clock base and returns state.
#[tauri::command]
fn get_phase_recorder_state(state: State<AppState>) -> Result<PhaseRecorderState, String> {
    let mut slot = state.phase_recorder.lock().map_err(|e| e.to_string())?;
    if let Some(rec) = slot.as_mut() {
        rec.check_phase_advance();
    }
    match slot.as_ref() {
        Some(rec) => Ok(phase_recorder_state(rec)),
        None => Ok(PhaseRecorderState {
            active: false,
            label: String::new(),
            current_phase: String::new(),
            current_phase_label: String::new(),
            current_phase_color: String::new(),
            current_phase_instruction: String::new(),
            phase_elapsed: 0.0,
            phase_duration: 0.0,
            phase_progress: 0.0,
            total_elapsed: 0.0,
            total_duration: 0.0,
            total_progress: 0.0,
            phases: Vec::new(),
            saved_path: None,
        }),
    }
}

// === WiFi Reader ===

#[tauri::command]
fn connect_wifi(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    host: String,
    port: u16,
    n_channels: usize,
) -> Result<String, String> {
    {
        let serial = state.serial_connected.lock().map_err(|e| e.to_string())?;
        if *serial {
            return Err("Serial connection active. Disconnect first.".to_string());
        }
        let wifi = state.wifi_connected.lock().map_err(|e| e.to_string())?;
        if *wifi {
            return Err("Already connected over WiFi. Disconnect first.".to_string());
        }
    }

    let stream = std::net::TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("Failed to connect to {}:{}: {}", host, port, e))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(100)))
        .map_err(|e| e.to_string())?;

    *state.wifi_connected.lock().map_err(|e| e.to_string())? = true;
    *state.wifi_host.lock().map_err(|e| e.to_string())? =
        Some(format!("{}:{}", host, port));
    *state.channel_count.lock().map_err(|e| e.to_string())? = n_channels.max(1);
    *state.serial_connected.lock().map_err(|e| e.to_string())? = false;
    state.current_readings.lock().map_err(|e| e.to_string())?.clear();

    let peer = stream.try_clone().map_err(|e| e.to_string())?;
    let connected_flag = state.wifi_connected.clone();
    let last_channels = state.last_channels.clone();
    let app_handle = app.clone();

    thread::spawn(move || {
        let mut reader = peer;
        let protocol = OsmProtocol::new(MAX_CHANNELS);
        let mut validator = SampleValidator::new();
        let mut buffer: Vec<u8> = Vec::with_capacity(1024);
        let mut chunk = [0u8; 512];
        loop {
            if !*connected_flag.lock().unwrap() {
                break;
            }
            match reader.read(&mut chunk) {
                Ok(0) => break, // EOF — stream closed.
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(e) => {
                    // Socket read timeouts/backpressure (WouldBlock) are normal
                    // pauses, NOT disconnects. Only break on real I/O errors.
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
                        continue;
                    }
                    break;
                }
            }
            let mut handled = 0usize;
            while let Some(rel) = buffer[handled..].iter().position(|&b| b == b'\n') {
                let end = handled + rel + 1;
                let line = String::from_utf8_lossy(&buffer[handled..end]);
                handle_reader_line(
                    &line,
                    &protocol,
                    MAX_CHANNELS,
                    &mut validator,
                    &app_handle,
                    &last_channels,
                );
                handled = end;
            }
            if handled > 0 {
                buffer.drain(..handled);
            } else if buffer.len() > 8192 {
                buffer.drain(..4096);
            }
        }
        *connected_flag.lock().unwrap() = false;
        let _ = app_handle.emit("wifi-disconnected", ());
    });

    Ok(format!("Connected to {}:{} over WiFi", host, port))
}

#[tauri::command]
fn disconnect_wifi(state: State<AppState>) -> Result<String, String> {
    *state.wifi_connected.lock().map_err(|e| e.to_string())? = false;
    Ok("Disconnected".to_string())
}

#[derive(Serialize, Deserialize)]
pub struct WifiStatus {
    pub connected: bool,
    pub host: String,
    pub channel_count: usize,
}

#[tauri::command]
fn get_wifi_status(state: State<AppState>) -> Result<WifiStatus, String> {
    let connected = *state.wifi_connected.lock().map_err(|e| e.to_string())?;
    let host = state.wifi_host.lock().map_err(|e| e.to_string())?.clone().unwrap_or_default();
    let channel_count = *state.channel_count.lock().map_err(|e| e.to_string())?;
    Ok(WifiStatus { connected, host, channel_count })
}

// === BLE Reader ===

/// Python `ble_reader.py` constants (Osmograph-BLE GATT service).
const BLE_SERVICE_UUID: &str = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const BLE_CHARACTERISTIC_UUID: &str = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BLE_DEVICE_NAME: &str = "Osmograph-BLE";

#[derive(Serialize, Deserialize, Clone)]
pub struct BleDeviceInfo {
    pub name: String,
    pub address: String,
}

#[derive(Serialize, Deserialize)]
pub struct BleStatus {
    pub connected: bool,
    pub address: String,
    pub channel_count: usize,
}

/// Scan for Osmograph-BLE devices (Python `BleReader._scan_for_device`, timeout default 5s).
#[tauri::command]
fn list_ble_devices(timeout_sec: Option<u64>) -> Result<Vec<BleDeviceInfo>, String> {
    let timeout = timeout_sec.unwrap_or(5);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(scan_ble_devices(timeout))
}

async fn scan_ble_devices(timeout: u64) -> Result<Vec<BleDeviceInfo>, String> {
    use btleplug::api::{Central as _, Manager as _, Peripheral as _, ScanFilter};
    let manager = btleplug::platform::Manager::new()
        .await
        .map_err(|e| e.to_string())?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "No BLE adapter available".to_string())?;

    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_secs(timeout)).await;
    let _ = adapter.stop_scan().await;

    let mut found = Vec::new();
    for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
        if let Ok(Some(props)) = p.properties().await {
            if let Some(name) = props.local_name {
                if name.contains(BLE_DEVICE_NAME) {
                    found.push(BleDeviceInfo {
                        name,
                        address: p.address().to_string(),
                    });
                }
            }
        }
    }
    Ok(found)
}

/// Connect and stream OSM readings over BLE notifications (Python `BleReader._stream`).
#[tauri::command]
fn connect_ble(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    address: String,
) -> Result<String, String> {
    {
        let serial = state.serial_connected.lock().map_err(|e| e.to_string())?;
        if *serial {
            return Err("Serial connection active. Disconnect first.".to_string());
        }
        let wifi = state.wifi_connected.lock().map_err(|e| e.to_string())?;
        if *wifi {
            return Err("WiFi connection active. Disconnect first.".to_string());
        }
        let ble = state.ble_connected.lock().map_err(|e| e.to_string())?;
        if *ble {
            return Err("Already connected over BLE. Disconnect first.".to_string());
        }
    }

    *state.ble_connected.lock().map_err(|e| e.to_string())? = true;
    *state.ble_device_address.lock().map_err(|e| e.to_string())? = Some(address.clone());
    *state.channel_count.lock().map_err(|e| e.to_string())? = MAX_CHANNELS;
    state.current_readings.lock().map_err(|e| e.to_string())?.clear();

    let bind_addr = address.clone();
    let connected_flag = state.ble_connected.clone();
    let last_channels = state.last_channels.clone();
    let app_handle = app.clone();
    let ok_msg = format!("Connecting to BLE device {}", address);

    thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string());
        let rt = match runtime {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("BLE runtime error: {}", e);
                *connected_flag.lock().unwrap() = false;
                let _ = app_handle.emit("ble-error", e);
                return;
            }
        };
        if let Err(e) = rt.block_on(stream_ble(&bind_addr, &connected_flag, &app_handle, &last_channels))
        {
            log::warn!("BLE stream error: {}", e);
        }
        *connected_flag.lock().unwrap() = false;
        let _ = app_handle.emit("ble-disconnected", ());
    });

    Ok(ok_msg)
}

async fn stream_ble(
    address: &str,
    connected_flag: &Arc<Mutex<bool>>,
    app: &tauri::AppHandle,
    last_channels: &Arc<Mutex<Vec<f64>>>,
) -> Result<(), String> {
    use btleplug::api::{Central as _, Manager as _, Peripheral as _};
    use futures::StreamExt;

    let service_uuid: uuid::Uuid = BLE_SERVICE_UUID
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let char_uuid: uuid::Uuid = BLE_CHARACTERISTIC_UUID
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;

    let manager = btleplug::platform::Manager::new()
        .await
        .map_err(|e| e.to_string())?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "No BLE adapter available".to_string())?;

    let peripheral = adapter
        .peripherals()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.address().to_string().eq_ignore_ascii_case(address))
        .ok_or_else(|| format!("BLE device {} not found — scan first", address))?;

    peripheral
        .connect()
        .await
        .map_err(|e| format!("BLE connect failed: {}", e))?;
    peripheral
        .discover_services()
        .await
        .map_err(|e| e.to_string())?;

    let characteristic = peripheral
        .services()
        .iter()
        .find(|s| s.uuid == service_uuid)
        .and_then(|s| s.characteristics.iter().find(|c| c.uuid == char_uuid).cloned())
        .ok_or_else(|| "Osmograph-BLE service/characteristic not found".to_string())?;

    peripheral
        .subscribe(&characteristic)
        .await
        .map_err(|e| e.to_string())?;

    let mut notifications = peripheral
        .notifications()
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("ble-connected", address.to_string());
    log::info!("BLE connected: {}", address);
    let protocol = OsmProtocol::new(MAX_CHANNELS);
    let mut validator = SampleValidator::new();
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        if !*connected_flag.lock().map_err(|e| e.to_string())? {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(50), notifications.next()).await {
            Ok(Some(notif)) => {
                if notif.uuid != char_uuid {
                    continue;
                }
                buffer.extend_from_slice(&notif.value);
                while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                    let raw: Vec<u8> = buffer.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&raw);
                    handle_reader_line(&line, &protocol, MAX_CHANNELS, &mut validator, app, last_channels);
                }
                if buffer.len() > 65536 {
                    buffer.clear();
                }
            }
            Ok(None) => break,
            Err(_elapsed) => {}
        }
    }

    let _ = peripheral.unsubscribe(&characteristic).await;
    let _ = peripheral.disconnect().await;
    let _ = app.emit("ble-disconnected", ());
    Ok(())
}

#[tauri::command]
fn disconnect_ble(state: State<AppState>) -> Result<String, String> {
    *state.ble_connected.lock().map_err(|e| e.to_string())? = false;
    *state.ble_device_address.lock().map_err(|e| e.to_string())? = None;
    Ok("Disconnected".to_string())
}

#[tauri::command]
fn get_ble_status(state: State<AppState>) -> Result<BleStatus, String> {
    let connected = *state.ble_connected.lock().map_err(|e| e.to_string())?;
    let address = state.ble_device_address.lock().map_err(|e| e.to_string())?.clone().unwrap_or_default();
    let channel_count = *state.channel_count.lock().map_err(|e| e.to_string())?;
    Ok(BleStatus { connected, address, channel_count })
}

// === Recordings / Library Index ===

#[derive(Serialize, Deserialize)]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub substance: String,
    pub duration_sec: f64,
    pub sensor_count: usize,
    pub rows: usize,
    pub file_id: String,
    pub mtime: f64,
}

#[tauri::command]
fn get_recordings_dir(state: State<AppState>) -> Result<String, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_recordings(state: State<AppState>) -> Result<Vec<RecordingFile>, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    scan_recordings(&dir)
}

fn scan_recordings(dir: &std::path::Path) -> Result<Vec<RecordingFile>, String> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|x| x == "csv").unwrap_or(false) {
            if let Some(meta) = std::fs::metadata(&path).ok() {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let (rows, sensor_count, duration_sec) = parse_csv_summary(&path);
                out.push(RecordingFile {
                    path: path.to_string_lossy().to_string(),
                    name: name.clone(),
                    substance: substance_from_filename(&name),
                    duration_sec,
                    sensor_count,
                    rows,
                    file_id: file_id_from_filename(&name),
                    mtime: meta
                        .modified()
                        .ok()
                        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap());
    Ok(out)
}

/// Best-effort header/rows/duration scan of a recorded CSV (Python library import parity).
fn parse_csv_summary(path: &std::path::Path) -> (usize, usize, f64) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0, 0.0),
    };
    let reader = std::io::BufReader::new(file);
    let mut rows = 0usize;
    let mut sensor_count = 0usize;
    let mut header_checked = false;
    let mut first_ts: Option<f64> = None;
    let mut last_ts: Option<f64> = None;
    for line in reader.lines().flatten() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !header_checked {
            header_checked = true;
            let cols = line.split(',').count();
            let has_ts = line.to_lowercase().starts_with("timestamp");
            sensor_count = cols.saturating_sub(if has_ts { 1 } else { 0 });
            continue;
        }
        rows += 1;
        if let Some(first) = line.split(',').next() {
            if let Ok(v) = first.trim().parse::<f64>() {
                if first_ts.is_none() {
                    first_ts = Some(v);
                }
                last_ts = Some(v);
            }
        }
    }
    let duration = match (first_ts, last_ts) {
        (Some(a), Some(b)) => ((b - a) / 1000.0).max(0.0),
        _ => 0.0,
    };
    (rows, sensor_count, duration)
}

/// `{YYYYMMDD_HHMMSS}_{safe_label}.csv` -> substance label (Python `suggest_label`-lite).
fn substance_from_filename(name: &str) -> String {
    let stem = name.strip_suffix(".csv").unwrap_or(name);
    let mut parts = stem.splitn(3, '_');
    let _date = parts.next();
    let _time = parts.next();
    let label = parts.next().unwrap_or("").replace(['_', '-'], " ").trim().to_string();
    let lower = label.to_lowercase();
    if ["room air", "air", "fresh", "baseline", "unknown", "empty", "blank", "clean"]
        .iter()
        .any(|k| lower.contains(k))
    {
        "unknown".to_string()
    } else {
        label
    }
}

fn file_id_from_filename(name: &str) -> String {
    let stem = name.strip_suffix(".csv").unwrap_or(name);
    let mut parts = stem.splitn(3, '_');
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    format!("{}_{}_000000", date, time)
}

#[tauri::command]
fn import_recordings(state: State<AppState>) -> Result<Vec<SessionRecord>, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let files = scan_recordings(&dir)?;
    let mut imported = Vec::new();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    for f in files {
        let exists = index
            .records
            .iter()
            .any(|r| r.csv_path == f.path || r.file_id == f.file_id);
        if exists {
            continue;
        }
        let record = build_record_from_file(&f);
        index.upsert(record.clone());
        imported.push(record);
    }
    let _ = index.save(&dir);
    Ok(imported)
}

/// Build a `SessionRecord` (unanalyzed) from a scanned `RecordingFile`.
fn build_record_from_file(f: &RecordingFile) -> SessionRecord {
    SessionRecord {
        file_id: f.file_id.clone(),
        substance: f.substance.clone(),
        label: "Imported".to_string(),
        csv_path: f.path.clone(),
        timestamp: f.mtime,
        duration_sec: f.duration_sec,
        sensor_count: f.sensor_count,
        preset_name: String::new(),
        notes: String::new(),
        opensmell_result: None,
        quality_report: None,
        quality: SessionIndex::provision_quality(f.duration_sec, f.rows),
    }
}

/// Import user-chosen files/folders from anywhere (not just the recordings dir).
/// Accepts absolute paths to `.csv`/`.osmell` files, or directories whose tree
/// is scanned for them. Deduplicates against the existing index.
#[tauri::command]
fn import_paths(state: State<AppState>, paths: Vec<String>) -> Result<Vec<SessionRecord>, String> {
    let mut files: Vec<RecordingFile> = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {}", p, e))?;
        if meta.is_dir() {
            collect_recordings_in_tree(&path, &mut files);
        } else if matches_file_ext(&path) {
            if let Some(rf) = recording_from_path(&path) {
                files.push(rf);
            }
        }
    }
    // Keep newest-first, dedupe by absolute path.
    files.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap());

    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let mut imported = Vec::new();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    let mut seen: std::collections::HashSet<String> = index
        .records
        .iter()
        .map(|r| r.csv_path.clone())
        .collect();
    for f in files {
        if seen.contains(&f.path) {
            continue;
        }
        let record = build_record_from_file(&f);
        seen.insert(record.csv_path.clone());
        index.upsert(record.clone());
        imported.push(record);
    }
    let _ = index.save(&dir);
    Ok(imported)
}

fn matches_file_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("csv") || e.eq_ignore_ascii_case("osmell"))
        .unwrap_or(false)
}

/// Read a single file into a `RecordingFile` (generalizes `scan_recordings`).
fn recording_from_path(path: &std::path::Path) -> Option<RecordingFile> {
    let meta = std::fs::metadata(path).ok()?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let (rows, sensor_count, duration_sec) = parse_csv_summary(path);
    Some(RecordingFile {
        path: path.to_string_lossy().to_string(),
        name: name.clone(),
        substance: substance_from_filename(&name),
        duration_sec,
        sensor_count,
        rows,
        file_id: file_id_from_filename(&name),
        mtime: meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0),
    })
}

/// Recursively scan a directory tree for recording files.
fn collect_recordings_in_tree(dir: &std::path::Path, out: &mut Vec<RecordingFile>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_recordings_in_tree(&path, out);
        } else if matches_file_ext(&path) {
            if let Some(rf) = recording_from_path(&path) {
                out.push(rf);
            }
        }
    }
}

#[tauri::command]
fn get_session_index(state: State<AppState>) -> Result<Vec<SessionRecord>, String> {
    let index = state.session_index.lock().map_err(|e| e.to_string())?;
    Ok(index.records.clone())
}

#[tauri::command]
fn remove_session(state: State<AppState>, file_id: String) -> Result<(), String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    index.remove_record_and_file(&dir, &file_id);
    let _ = index.save(&dir);
    Ok(())
}

/// Rename a recorded session from the library: updates the substance/label in
/// the index AND renames the on-disk file (keeping its `YYYYMMDD_HHMMSS_`
/// timestamp prefix) so the library always matches what is stored.
#[tauri::command]
fn rename_session(state: State<AppState>, file_id: String, new_name: String) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("Enter a name before renaming.".to_string());
    }
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
        return Err("Keep the name simple — no / \\ or : characters.".to_string());
    }
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    let Some(record) = index.records.iter_mut().find(|r| r.file_id == file_id) else {
        return Err("Session not found in the library.".to_string());
    };

    // Preserve the canonical timestamp prefix; fall back to the original stem.
    let old_path = std::path::PathBuf::from(&record.csv_path);
    let old_stem = old_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = old_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "csv".to_string());
    let mut parts = old_stem.splitn(3, '_');
    let (date, time, rest) = (
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
        parts.next(),
    );
    let slug = new_name.replace(' ', "_");
    let new_stem = if !date.is_empty() && !time.is_empty() && rest.is_some() {
        format!("{}_{}_{}", date, time, slug)
    } else {
        format!("{}_{}", old_stem, slug)
    };
    let new_path = old_path.with_file_name(format!("{}.{}", new_stem, ext));

    if new_path != old_path {
        std::fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Rename failed: {} (file may be open elsewhere).", e))?;
    }
    record.label = new_name.clone();
    record.substance = new_name.clone();
    record.csv_path = new_path.to_string_lossy().to_string();
    let _ = index.save(&dir);
    Ok(())
}

fn current_preset_name(state: &State<'_, AppState>) -> String {
    match *state.channel_count.lock().unwrap_or_else(|e| e.into_inner()) {
        3 => "3-sensor",
        4 => "4-sensor",
        _ => "6-sensor-full",
    }
    .to_string()
}

/// Score one indexed recording with the opensmell quality scorer and stash the
/// report (`quality_report`) on its `SessionRecord`. Mirrors the Python app's
/// `.osmell`/CSV import analysis (`app.py`). Dispatches on extension so an
/// indexed `.osmell` phase recording (whose `csv_path` is the bundle) is
/// analyzed from its manifest rather than misread as CSV.
fn analyze_session_file(path: &str) -> Result<opensmell::quality::QualityReport, String> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext == "osmell" {
        return analyze_osmell_file(p);
    }

    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let parsed = data::csv_parse::parse_session_csv(&text)?;
    let channels: Vec<opensmell::ChannelSeries> = parsed
        .channels
        .iter()
        .map(|(id, values)| opensmell::ChannelSeries::new(id.clone(), values.clone()))
        .collect();
    let params = opensmell::QualityParams {
        adc_max: None,
        sampling_rate_hz: None,
        guess_sampling_rate_hz: parsed.guess_sampling_rate_hz,
        role: "single".to_string(),
        baseline_source: "none".to_string(),
        r0_samples: None,
        unsorted_rows: parsed.unsorted,
        non_finite_samples: parsed.non_finite,
    };
    let mut report = opensmell::compute_quality(&parsed.time, &channels, &params);
    // Surface the tolerant-parser warnings (order/delimiter/rate heuristics) so
    // they reach the quality report instead of being silently dropped. Mirrors
    // `app.py` merging parser warnings into the report notes.
    report.notes.extend(
        parsed
            .warnings
            .iter()
            .map(|w| format!("CSV parser: {}", w)),
    );
    Ok(report)
}

/// Analyze a `.osmell` bundle: carry the manifest's declared calibration
/// parameters (ADC max, sampling rate, role, baseline source, R0) into the
/// quality scorer instead of guessing them from a raw CSV.
fn analyze_osmell_file(p: &std::path::Path) -> Result<opensmell::quality::QualityReport, String> {
    let b = data::osmell_read::read_osmell(p)?;
    let channels: Vec<opensmell::ChannelSeries> = b
        .channels
        .iter()
        .map(|(id, values)| opensmell::ChannelSeries::new(id.clone(), values.clone()))
        .collect();
    // Estimate a fallback sampling rate from the time series when the manifest
    // does not declare one, so the scorer never sees a zero guess for a valid
    // bundle (mirrors the CSV parser's heuristic-rate behavior).
    let fallback_rate = b.sampling_rate_hz.or_else(|| {
        if b.time.len() >= 2 {
            let dt = (b.time[1] - b.time[0]).abs();
            if dt > 0.0 {
                Some(1.0 / dt)
            } else {
                None
            }
        } else {
            None
        }
    }).unwrap_or(0.0);
    let params = opensmell::QualityParams {
        adc_max: b.adc_max,
        sampling_rate_hz: b.sampling_rate_hz,
        guess_sampling_rate_hz: fallback_rate,
        role: b.role.clone(),
        baseline_source: b.baseline_source.clone(),
        r0_samples: b.r0_samples,
        unsorted_rows: false,
        non_finite_samples: 0,
    };
    Ok(opensmell::compute_quality(&b.time, &channels, &params))
}

#[tauri::command]
fn analyze_recording(state: State<AppState>, file_id: String) -> Result<String, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    let path = index
        .records
        .iter()
        .find(|r| r.file_id == file_id)
        .map(|r| r.csv_path.clone())
        .ok_or_else(|| format!("No session with file_id \"{}\"", file_id))?;

    let report = analyze_session_file(&path)?;
    let json = serde_json::to_string(&report).map_err(|e| e.to_string())?;

    if let Some(r) = index.records.iter_mut().find(|r| r.file_id == file_id) {
        r.quality_report = Some(json.clone());
        if let Some(total) = report.total {
            r.quality = total;
        }
    }
    let _ = index.save(&dir);
    Ok(json)
}

/// Per-channel series for a session, time relative to the first sample (s).
/// Mirrors the Python compare panel's `_load_csv` / `_load_osmell` (viz/compare_panel.py).
#[derive(Serialize)]
pub struct SessionSeries {
    pub label: String,
    pub channels: Vec<String>,
    pub time: Vec<f64>,
    pub values: Vec<Vec<f64>>,
}

#[tauri::command]
fn export_session_copy(state: State<AppState>, file_id: String, output_path: String) -> Result<String, String> {
    let index = state.session_index.lock().map_err(|e| e.to_string())?;
    data::export::export_session_copy(&index, &file_id, std::path::Path::new(&output_path))
}

#[tauri::command]
fn export_session_osmell(state: State<AppState>, file_id: String, output_path: String) -> Result<String, String> {
    let index = state.session_index.lock().map_err(|e| e.to_string())?;
    data::export::export_session_osmell(&index, &file_id, std::path::Path::new(&output_path))
}

fn relative_seconds(ms: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(ms.len());
    if let Some(t0) = ms.first() {
        for t in ms {
            out.push((t - t0) / 1000.0);
        }
    }
    out
}

fn load_session_series_for(path: &str) -> Result<SessionSeries, String> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "osmell" {
        let b = data::osmell_read::read_osmell(p)?;
        Ok(SessionSeries {
            label: String::new(),
            channels: b.channels.iter().map(|(id, _)| id.clone()).collect(),
            time: relative_seconds(&b.time),
            values: b.channels.iter().map(|(_, vals)| vals.clone()).collect(),
        })
    } else {
        let text = std::fs::read_to_string(p)
            .map_err(|e| format!("Failed to read {}: {}", path, e))?;
        let parsed = data::csv_parse::parse_session_csv(&text)?;
        Ok(SessionSeries {
            label: String::new(),
            channels: parsed.channels.iter().map(|(id, _)| id.clone()).collect(),
            time: relative_seconds(&parsed.time),
            values: parsed.channels.iter().map(|(_, vals)| vals.clone()).collect(),
        })
    }
}

#[tauri::command]
fn load_session_series(state: State<AppState>, file_id: String) -> Result<SessionSeries, String> {
    let index = state.session_index.lock().map_err(|e| e.to_string())?;
    let rec = index
        .records
        .iter()
        .find(|r| r.file_id == file_id)
        .ok_or_else(|| format!("No session with file_id \"{}\"", file_id))?;
    let name = std::path::Path::new(&rec.csv_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let label = if !rec.substance.trim().is_empty() && rec.substance.trim() != "unknown" {
        rec.substance.trim().to_string()
    } else if !rec.label.trim().is_empty() {
        rec.label.trim().to_string()
    } else {
        name
    };
    let mut series = load_session_series_for(&rec.csv_path)?;
    series.label = label;
    Ok(series)
}

#[derive(Serialize, Deserialize)]
pub struct SessionSummary {
    pub duration_seconds: f64,
    pub n_readings: usize,
    pub start_time: f64,
    pub record_path: Option<String>,
    pub file_id: Option<String>,
    pub substance: String,
    pub quality_score: f64,
}

// === Sensor Health ===

#[tauri::command]
fn get_sensor_health(state: State<AppState>) -> Result<Vec<SensorHealthInfo>, String> {
    let readings = state.current_readings.lock().map_err(|e| e.to_string())?;
    if readings.is_empty() { return Ok(vec![]); }

    let n_channels = readings[0].len().min(8);
    let mut health = Vec::new();

    for ch in 0..n_channels {
        let values: Vec<f64> = readings.iter().filter_map(|r| r.get(ch).copied()).collect();
        if values.is_empty() { continue; }
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
        let std_dev = variance.sqrt();
        let cv = if mean > 0.0 { std_dev / mean } else { 0.0 };
        let health_score = if cv < 0.1 { 1.0 } else if cv < 0.2 { 0.7 } else if cv < 0.3 { 0.4 } else { 0.1 };
        health.push(SensorHealthInfo {
            channel: ch,
            health_score,
            mean,
            std: std_dev,
            cv,
            status: if health_score > 0.7 { "OK".into() } else if health_score > 0.4 { "WARNING".into() } else { "CRITICAL".into() },
        });
    }
    Ok(health)
}

#[derive(Serialize, Deserialize)]
pub struct SensorHealthInfo {
    pub channel: usize,
    pub health_score: f64,
    pub mean: f64,
    pub std: f64,
    pub cv: f64,
    pub status: String,
}

// === Data Export ===

#[tauri::command]
fn export_labeled_data(state: State<AppState>, output_dir: String) -> Result<String, String> {
    let labeling = state.labeling.lock().map_err(|e| e.to_string())?;
    let path = std::path::Path::new(&output_dir);
    labeling.export_for_commons(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_readings_buffer(state: State<AppState>) -> Result<Vec<Vec<f64>>, String> {
    let readings = state.current_readings.lock().map_err(|e| e.to_string())?;
    Ok(readings.clone())
}

#[tauri::command]
fn save_session_csv(state: State<AppState>, output_path: String) -> Result<String, String> {
    let readings = state.current_readings.lock().map_err(|e| e.to_string())?;
    if readings.is_empty() {
        return Err("No readings to save".to_string());
    }

    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    let n_channels = readings[0].len();
    let header: Vec<String> = (0..n_channels).map(|i| format!("ch_{}", i)).collect();
    wtr.write_record(&header).map_err(|e| e.to_string())?;

    for row in readings.iter() {
        let record: Vec<String> = row.iter().map(|v| format!("{:.6}", v)).collect();
        wtr.write_record(&record).map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(format!("Saved {} readings to {}", readings.len(), output_path))
}

// === Fleet Management ===

#[derive(Serialize, Deserialize, Clone)]
pub struct FleetSensorState {
    pub name: String,
    pub value: f64,
    pub health: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FleetDeviceState {
    pub id: String,
    pub name: String,
    pub status: String,
    pub port: String,
    pub n_channels: usize,
    pub firmware_version: String,
    pub uptime_seconds: f64,
    pub ip: String,
    /// Human/Machine label describing what the device is: "osmograph-e-nose"
    /// for a recognised ESP32 e-nose, or "unknown-usb" / "unknown-mdns" so the
    /// UI can clearly mark anything that is not (yet) confirmed to be an e-nose.
    pub kind: String,
    /// True when the device is a recognised ESP32-family e-nose (known VID:PID
    /// or advertises the _osmograph._tcp service). Unknown devices are still
    /// listed — never hidden — so DIY/indie builders are not locked out.
    pub is_recognized: bool,
    pub sensors: Vec<FleetSensorState>,
}

fn default_sensors(n: usize) -> Vec<FleetSensorState> {
    (1..=n.max(1))
        .map(|i| FleetSensorState {
            name: format!("CH{}", i),
            value: 0.0,
            health: "OK".to_string(),
        })
        .collect()
}

// --- Network discovery: mDNS `_osmograph._tcp` + OSM INFO probe ---

#[derive(Serialize, Deserialize, Clone)]
pub struct DiscoveredDevice {
    pub fullname: String,
    pub host: String,
    pub ip: String,
    pub port: u16,
    pub firmware_version: String,
    pub n_channels: usize,
}

/// Connect to an OSM TCP server and read its first line (INFO,<id>,<fw>,<n>).
fn probe_osm_info(host: &str, port: u16) -> Option<(String, usize)> {
    use std::net::ToSocketAddrs;
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let mut line = String::new();
    BufReader::new(&mut stream).read_line(&mut line).ok()?;
    let parts: Vec<&str> = line.trim().split(',').collect();
    if parts.len() < 4 || parts[0] != "INFO" {
        return None;
    }
    let fw = parts[2].trim().to_string();
    let n = parts[3].trim().parse().unwrap_or(0);
    Some((fw, n))
}

/// Browse for `_osmograph._tcp.local.` services and resolve each to an OSM endpoint.
fn mdns_discover(timeout: Duration) -> Vec<DiscoveredDevice> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("mDNS daemon failed: {}", e);
            return Vec::new();
        }
    };
    let receiver = match daemon.browse("_osmograph._tcp.local.") {
        Ok(r) => r,
        Err(e) => {
            log::warn!("mDNS browse failed: {}", e);
            let _ = daemon.shutdown();
            return Vec::new();
        }
    };
    let deadline = std::time::Instant::now() + timeout;
    let mut devices: Vec<DiscoveredDevice> = Vec::new();
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match receiver.recv_timeout(deadline - now) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let fullname = info.get_fullname().to_string();
                if devices.iter().any(|d| d.fullname == fullname) {
                    continue;
                }
                let host = info.get_hostname().trim_end_matches('.').to_string();
                let port = info.get_port();
                let addrs = info.get_addresses();
                let ip = addrs.iter().find(|a| a.is_ipv4()).or_else(|| addrs.iter().next())
                    .map(|a| a.to_string()).unwrap_or_default();
                let connect_host = if ip.is_empty() { host.as_str() } else { ip.as_str() };
                let (firmware_version, n_channels) = probe_osm_info(connect_host, port)
                    .unwrap_or(("unknown".to_string(), 0));
                devices.push(DiscoveredDevice {
                    fullname,
                    host,
                    ip,
                    port,
                    firmware_version,
                    n_channels,
                });
            }
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    devices
}

#[tauri::command]
fn fleet_scan(state: State<AppState>) -> Result<Vec<FleetDeviceState>, String> {
    let mut devices: Vec<FleetDeviceState> = Vec::new();

    for (i, p) in list_serial_ports()?.iter().enumerate() {
        if let Some(d) = serial_fleet_entry(i, &p.name, &p.description) {
            devices.push(d);
        }
    }

    for d in mdns_discover(Duration::from_secs(4)) {
        let n = if d.n_channels > 0 { d.n_channels } else { 6 };
        devices.push(FleetDeviceState {
            id: format!("mdns-{}", d.fullname),
            name: d.host.clone(),
            status: "online".to_string(),
            port: format!("TCP:{}", d.port),
            n_channels: n,
            firmware_version: d.firmware_version,
            uptime_seconds: 0.0,
            ip: d.ip,
            // Only _osmograph._tcp services are browsed, so every mDNS hit is a
            // confirmed Osmograph e-nose advertising over the network.
            kind: "osmograph-e-nose".to_string(),
            is_recognized: true,
            sensors: default_sensors(n),
        });
    }

    let mut fleet = state.fleet.lock().map_err(|e| e.to_string())?;
    *fleet = devices.clone();
    Ok(devices)
}

#[tauri::command]
fn fleet_add_device(state: State<AppState>, name: String, port: String) -> Result<FleetDeviceState, String> {
    // Manual add — the target may not be a physically-present USB/BT device, so
    // always create an offline, unverified manual entry rather than requiring it
    // to be enumerated (unlike the auto-scan path).
    let device = FleetDeviceState {
        id: format!("device-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()),
        name,
        status: "offline".to_string(),
        port,
        n_channels: 6,
        firmware_version: "unknown".to_string(),
        uptime_seconds: 0.0,
        ip: String::new(),
        kind: "manual-add".to_string(),
        is_recognized: false,
        sensors: default_sensors(6),
    };
    let mut fleet = state.fleet.lock().map_err(|e| e.to_string())?;
    fleet.push(device.clone());
    Ok(device)
}

#[tauri::command]
fn fleet_remove_device(state: State<AppState>, device_id: String) -> Result<(), String> {
    let mut fleet = state.fleet.lock().map_err(|e| e.to_string())?;
    fleet.retain(|d| d.id != device_id);
    Ok(())
}

#[tauri::command]
fn fleet_get_all(state: State<AppState>) -> Result<Vec<FleetDeviceState>, String> {
    let fleet = state.fleet.lock().map_err(|e| e.to_string())?;
    Ok(fleet.clone())
}

// === OLED Configuration ===

#[derive(Serialize, Deserialize, Clone)]
pub struct OledConfig {
    pub screen_size: String,
    pub layout: String,
    pub rotation: u16,
    pub cycle_interval_secs: u16,
}

impl Default for OledConfig {
    fn default() -> Self {
        Self {
            screen_size: "128x64".into(),
            layout: "overview".into(),
            rotation: 0,
            cycle_interval_secs: 5,
        }
    }
}

#[tauri::command]
fn oled_get_config(state: State<AppState>) -> Result<OledConfig, String> {
    let cfg = state.oled_config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
fn oled_set_config(state: State<AppState>, config: OledConfig) -> Result<OledConfig, String> {
    let mut cfg = state.oled_config.lock().map_err(|e| e.to_string())?;
    *cfg = config.clone();
    Ok(config)
}

// === Buzzer Configuration ===

#[derive(Serialize, Deserialize, Clone)]
pub struct BuzzerConfig {
    pub warning_pattern: String,
    pub critical_pattern: String,
    pub emergency_pattern: String,
    pub volume: u8,
    pub frequency_hz: u16,
}

impl Default for BuzzerConfig {
    fn default() -> Self {
        Self {
            warning_pattern: "double".into(),
            critical_pattern: "continuous".into(),
            emergency_pattern: "continuous".into(),
            volume: 70,
            frequency_hz: 2000,
        }
    }
}

#[tauri::command]
fn buzzer_get_config(state: State<AppState>) -> Result<BuzzerConfig, String> {
    let cfg = state.buzzer_config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
fn buzzer_set_config(state: State<AppState>, config: BuzzerConfig) -> Result<BuzzerConfig, String> {
    let mut cfg = state.buzzer_config.lock().map_err(|e| e.to_string())?;
    *cfg = config.clone();
    Ok(config)
}

// === Data Commons ===

#[tauri::command]
fn commons_submit(csv_path: String, metadata_path: String, data_dir: String) -> Result<ContributionInfo, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let contribution = pipeline.submit(
        std::path::Path::new(&csv_path),
        std::path::Path::new(&metadata_path),
    ).map_err(|e| e.to_string())?;
    Ok(ContributionInfo {
        id: contribution.id,
        substance: contribution.substance,
        quality_score: contribution.quality_score,
        status: format!("{:?}", contribution.status),
        n_samples: contribution.n_samples,
        n_channels: contribution.n_channels,
        verification_log: contribution.verification_log,
    })
}

#[derive(Serialize, Deserialize)]
pub struct ContributionInfo {
    pub id: String,
    pub substance: String,
    pub quality_score: f64,
    pub status: String,
    pub n_samples: usize,
    pub n_channels: usize,
    pub verification_log: Vec<String>,
}

fn to_contribution_info(c: &data_commons::Contribution) -> ContributionInfo {
    ContributionInfo {
        id: c.id.clone(),
        substance: c.substance.clone(),
        quality_score: c.quality_score,
        status: format!("{:?}", c.status),
        n_samples: c.n_samples,
        n_channels: c.n_channels,
        verification_log: c.verification_log.clone(),
    }
}

// === Data Hub ===

#[derive(Serialize, Deserialize)]
pub struct HubEntry {
    pub id: String,
    pub contributor: String,
    pub substance: String,
    pub device_id: String,
    pub submitted_at: String,
    pub quality_score: f64,
    pub status: String,
    pub n_samples: usize,
    pub n_channels: usize,
    pub verification_log: Vec<String>,
    pub data_path: String,
}

#[tauri::command]
fn hub_list(data_dir: String) -> Result<Vec<HubEntry>, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let all = pipeline.list_all().map_err(|e| e.to_string())?;
    Ok(all
        .into_iter()
        .map(|c| HubEntry {
            id: c.id.clone(),
            contributor: c.contributor.clone(),
            substance: c.substance.clone(),
            device_id: c.device_id.clone(),
            submitted_at: c.submitted_at.to_rfc3339(),
            quality_score: c.quality_score,
            status: format!("{:?}", c.status),
            n_samples: c.n_samples,
            n_channels: c.n_channels,
            verification_log: c.verification_log,
            data_path: c.data_path.to_string_lossy().to_string(),
        })
        .collect())
}

#[tauri::command]
fn hub_approve(data_dir: String, id: String) -> Result<ContributionInfo, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let c = pipeline.approve(&id).map_err(|e| e.to_string())?;
    Ok(to_contribution_info(&c))
}

#[tauri::command]
fn hub_reject(data_dir: String, id: String, reason: String) -> Result<ContributionInfo, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let reason = if reason.trim().is_empty() {
        "Rejected by reviewer"
    } else {
        reason.trim()
    };
    let c = pipeline.reject(&id, reason).map_err(|e| e.to_string())?;
    Ok(to_contribution_info(&c))
}

#[tauri::command]
fn hub_publish(data_dir: String, id: String) -> Result<ContributionInfo, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let c = pipeline.publish(&id).map_err(|e| e.to_string())?;
    Ok(to_contribution_info(&c))
}

/// Import an external/research CSV into the library and recordings directory.
#[tauri::command]
fn hub_import_csv(state: State<'_, AppState>, path: String) -> Result<data::SessionRecord, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
    data::hub::import_external_csv(&dir, &mut index, std::path::Path::new(&path))
}

// === Hugging Face community sync ===

#[tauri::command]
fn hf_list(repo: String) -> Result<Vec<data::hub::HfFile>, String> {
    data::hub::hf_list_dataset_files(&repo)
}

#[tauri::command]
fn hf_download(
    state: State<'_, AppState>,
    repo: String,
    filename: String,
) -> Result<String, String> {
    let dir = state.recordings_dir.lock().map_err(|e| e.to_string())?.clone();
    let dest = data::hub::hf_download_file(&dir, &repo, &filename)?;
    let ext = data::hub::download_extension(&filename);
    if ext == "csv" {
        let mut index = state.session_index.lock().map_err(|e| e.to_string())?;
        let rec = data::hub::import_external_csv(&dir, &mut index, std::path::Path::new(&dest))?;
        Ok(format!(
            "Downloaded and imported '{}' as session '{}' (file_id {}).",
            filename, rec.substance, rec.file_id
        ))
    } else {
        Ok(format!("Downloaded '{}' to {}", filename, dest))
    }
}

#[tauri::command]
fn hf_set_token(token: String) -> Result<String, String> {
    data::hub::set_hf_token(&token)?;
    Ok("Hugging Face write token held in memory for this session (never written to disk)".to_string())
}

#[tauri::command]
fn hf_has_token() -> Result<bool, String> {
    Ok(data::hub::has_hf_token())
}

#[tauri::command]
fn hf_clear_token() -> Result<(), String> {
    data::hub::clear_hf_token();
    Ok(())
}

/// Upload a `Published` contribution's data to a HF dataset. Only
/// human-vetted (approved + published) contributions are eligible. The write
/// token is taken from the in-memory session value (set via `hf_set_token`
/// from the user's prompt); it is never read from disk or embedded.
#[tauri::command]
fn hf_upload(
    data_dir: String,
    repo: String,
    id: String,
    commit_message: Option<String>,
) -> Result<String, String> {
    let pipeline = data_commons::VerificationPipeline::new(std::path::Path::new(&data_dir));
    let c = pipeline.get(&id).map_err(|e| e.to_string())?;
    if !matches!(c.status, data_commons::ContributionStatus::Published) {
        return Err(format!(
            "Contribution {} must be human-reviewed and Published before upload (status {:?}). Approve then Publish it in the Data Hub first.",
            id, c.status
        ));
    }
    let csv = if c.data_path.is_file() {
        c.data_path.clone()
    } else {
        // Fall back to the file next to the metadata if paths moved.
        c.metadata_path.with_extension("csv")
    };
    if !csv.is_file() {
        return Err(format!("Data file missing for contribution {}: {}", id, csv.display()));
    }
    let default_msg = format!("OpenSmell session {} ({})", c.substance, c.id.chars().take(8).collect::<String>());
    let msg = commit_message.filter(|m| !m.trim().is_empty()).unwrap_or(default_msg);
    let committed = data::hub::hf_upload_csv(&repo, &csv, &msg)?;
    Ok(format!("Uploaded {} as '{}'", csv.file_name().unwrap_or_default().to_string_lossy(), committed))
}
// === Burn-In tracker ===

/// Path next to the recordings dir that persists `.burnin.json`.
fn burnin_dir(state: &State<'_, AppState>) -> std::path::PathBuf {
    state
        .recordings_dir
        .lock()
        .map(|d| d.clone())
        .unwrap_or_else(|_| std::env::temp_dir().join("osmograph"))
}

#[tauri::command]
fn burnin_get_status(state: State<'_, AppState>) -> Result<burnin::BurnInStatus, String> {
    burnin::get_status(&burnin_dir(&state))
}

#[tauri::command]
fn burnin_start(state: State<'_, AppState>) -> Result<burnin::BurnInStatus, String> {
    burnin::start(&burnin_dir(&state))
}

#[tauri::command]
fn burnin_reset(state: State<'_, AppState>, hours: Option<f64>) -> Result<burnin::BurnInStatus, String> {
    burnin::reset(&burnin_dir(&state), hours)
}

// === Plugins ===

#[tauri::command]
fn discover_plugins() -> Result<Vec<plugins::PluginInfo>, String> {
    plugins::discover(&plugins::default_plugin_dir())
}

#[tauri::command]
fn get_plugins_dir() -> Result<String, String> {
    let dir = plugins::default_plugin_dir();
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

// === Tauri Entry ===

#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("osmograph");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    let state = AppState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_serial,
            disconnect_serial,
            get_serial_status,
            connect_wifi,
            disconnect_wifi,
            get_wifi_status,
            list_ble_devices,
            connect_ble,
            disconnect_ble,
            get_ble_status,
            detect_board,
            flash_firmware,
            check_flash_toolchain,
            erase_flash,
            read_mac,
            ingest_reading,
            ingest_reading_with_failsafe,
            label_sample,
            get_labeling_stats,
            get_detector_state,
            get_learning_progress,
            calibrate_baseline,
            start_session,
            stop_session,
            start_phase_recording,
            stop_phase_recording,
            cancel_phase_recording,
            get_phase_recorder_state,
            get_readings_buffer,
            get_sensor_health,
            export_labeled_data,
            save_session_csv,
            get_recordings_dir,
            list_recordings,
            import_recordings,
            import_paths,
            get_session_index,
            remove_session,
            rename_session,
            analyze_recording,
            export_session_copy,
            export_session_osmell,
            load_session_series,
            fleet_scan,
            fleet_add_device,
            fleet_remove_device,
            fleet_get_all,
            oled_get_config,
            oled_set_config,
            buzzer_get_config,
            buzzer_set_config,
            commons_submit,
            get_data_dir,
            hub_list,
            hub_approve,
            hub_reject,
            hub_publish,
            hub_import_csv,
            hf_list,
            hf_download,
            hf_set_token,
            hf_has_token,
            hf_clear_token,
            hf_upload,
            burnin_get_status,
            burnin_start,
            burnin_reset,
            discover_plugins,
            get_plugins_dir,
            classifier::train_classifier,
            classifier::list_classifiers,
            classifier::delete_classifier,
            classifier::get_classifier,
            live::load_live_classifier,
            live::unload_live_classifier,
            live::get_live_classification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{board_label, classify_vid_pid};

    #[test]
    fn classify_known_usb_bridges() {
        assert_eq!(classify_vid_pid(0x10C4, 0xEA60), "esp32"); // CP2102
        assert_eq!(classify_vid_pid(0x1A86, 0x7523), "esp32"); // CH340
        assert_eq!(classify_vid_pid(0x10C4, 0xEA70), "esp32"); // CP2105
        assert_eq!(classify_vid_pid(0x303A, 0x0002), "esp32"); // ESP32-S2/S3
        assert_eq!(classify_vid_pid(0x303A, 0x1001), "esp32"); // ESP32-S3
    }

    #[test]
    fn classify_known_dev_boards() {
        assert_eq!(classify_vid_pid(0x2E8A, 0x0005), "raspberry_pi_pico");
        assert_eq!(classify_vid_pid(0x2341, 0x0043), "arduino_uno");
        assert_eq!(classify_vid_pid(0x2341, 0x0001), "arduino_uno");
    }

    #[test]
    fn classify_unknown_vid_pid() {
        assert_eq!(classify_vid_pid(0xDEAD, 0xBEEF), "unknown");
        assert_eq!(classify_vid_pid(0x2341, 0x9999), "unknown");
    }

    #[test]
    fn board_labels() {
        assert_eq!(board_label("esp32"), "ESP32");
        assert_eq!(board_label("arduino_uno"), "Arduino Uno");
        assert_eq!(board_label("raspberry_pi_pico"), "Raspberry Pi Pico");
        assert_eq!(board_label("unknown"), "Unknown Board");
    }

    #[test]
    fn analyze_csv_session_report() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("osm_test_analyze");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("20260828_120000_test sample.csv");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"timestamp_ms,VOC\n").unwrap();
        for (i, t) in [0, 100, 200, 300, 400, 500, 600, 700, 800, 5000].iter().enumerate() {
            file.write_all(format!("{t},{}\n", 1000.0 + 10.0 * i as f64).as_bytes()).unwrap();
        }
        drop(file);
        let report = super::analyze_session_file(path.to_str().unwrap()).unwrap();
        assert_eq!(report.total, Some(40.0));
        assert_eq!(report.badge, "Poor");
        assert_eq!(report.flags.used_default_adc_max, true);
        assert_eq!(report.flags.used_median_sampling_rate, true);
        assert_eq!(report.flags.no_baseline, true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_csv_session_series() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("osm_test_series");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("20260828_120000_coffee.csv");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"timestamp_ms,VOC,CO\n0,1000.0,20.0\n100,1100.0,25.0\n200,1300.0,30.0\n500,1600.0,40.0\n").unwrap();
        drop(file);
        let s = super::load_session_series_for(path.to_str().unwrap()).unwrap();
        assert_eq!(s.channels, vec!["VOC", "CO"]);
        assert_eq!(s.time, vec![0.0, 0.1, 0.2, 0.5]);
        assert_eq!(s.values[0], vec![1000.0, 1100.0, 1300.0, 1600.0]);
        assert_eq!(s.values[1], vec![20.0, 25.0, 30.0, 40.0]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
