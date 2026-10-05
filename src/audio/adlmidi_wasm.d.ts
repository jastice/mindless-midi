/** The subset of libADLMIDI's Emscripten module that we call directly. */
export interface AdlModule {
  HEAP16: Int16Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _adl_init(sampleRate: number): number;
  _adl_setNumChips(player: number, chips: number): number;
  _adl_setSoftPanEnabled(player: number, on: number): void;
  _adl_switchEmulator(player: number, emulator: number): number;
  _adl_setBank(player: number, bank: number): number;
  _adl_reset(player: number): void;
  _adl_panic(player: number): void;
  _adl_rt_resetState(player: number): void;
  _adl_generate(player: number, samples: number, buffer: number): number;
  _adl_rt_noteOn(player: number, ch: number, key: number, vel: number): number;
  _adl_rt_noteOff(player: number, ch: number, key: number): void;
  _adl_rt_controllerChange(player: number, ch: number, cc: number, value: number): void;
  _adl_rt_patchChange(player: number, ch: number, program: number): void;
}

export type CreateAdlModule = (config?: {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance) => void,
  ) => object;
}) => Promise<AdlModule>;
