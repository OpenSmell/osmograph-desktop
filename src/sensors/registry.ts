// Sensor type registry. Maps sensor_type strings -> BaseSensorType handlers.
//
// Register every supported type here. Osmograph's ingestion pipeline looks up
// the handler by record.slots[].sensor_type and normalizes each slot through
// its handler, so mixed-rig rigs (MOX next to NDIR next to piezo) are handled
// per-slot without cross-contamination.
//
// Third-party module makers can extend this registry via the Osmograph SDK.

import { BaseSensorType, type SensorType } from './base'
import { MoxHandler } from './types/mox'
import { NdirHandler } from './types/ndir'
import { PidHandler } from './types/pid'
import { ElectrochemicalHandler } from './types/electrochemical'
import { GalvanicHandler } from './types/galvanic'
import { CatalyticBeadHandler } from './types/catalytic-bead'
import { MemsHandler } from './types/mems'
import { PasHandler } from './types/pas'
import { PiezoHandler } from './types/piezo'
import { SawHandler } from './types/saw'
import { CantileverHandler } from './types/cantilever'
import { PolymerHandler } from './types/polymer'
import { SolidElectrolyteHandler } from './types/solid-electrolyte'
import { PhIsfetHandler } from './types/ph-isfet'
import { EnvTrhHandler } from './types/env-trh'
import { OtherHandler } from './types/other'
import { UnknownHandler } from './types/unknown'

const BUILTIN_HANDLERS: Array<BaseSensorType> = [
  new MoxHandler(),
  new NdirHandler(),
  new PidHandler(),
  new ElectrochemicalHandler(),
  new GalvanicHandler(),
  new CatalyticBeadHandler(),
  new MemsHandler(),
  new PasHandler(),
  new PiezoHandler(),
  new SawHandler(),
  new CantileverHandler(),
  new PolymerHandler(),
  new SolidElectrolyteHandler(),
  new PhIsfetHandler(),
  new EnvTrhHandler(),
  new OtherHandler(),
  new UnknownHandler(),
]

export class SensorTypeRegistry {
  private handlers = new Map<SensorType, BaseSensorType>()

  constructor() {
    for (const h of BUILTIN_HANDLERS) {
      this.handlers.set(h.type, h)
    }
  }

  register(handler: BaseSensorType): void {
    this.handlers.set(handler.type, handler)
  }

  get(type: SensorType | string): BaseSensorType {
    const t = type as SensorType
    const h = this.handlers.get(t)
    if (h) return h
    return this.handlers.get('unknown')!
  }

  has(type: SensorType | string): boolean {
    return this.handlers.has(type as SensorType)
  }

  types(): SensorType[] {
    return Array.from(this.handlers.keys())
  }
}

export const sensorTypeRegistry = new SensorTypeRegistry()
