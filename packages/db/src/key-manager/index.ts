// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/db/key-manager: the key wrapping port on a subpath of its own, so a
// key manager backend can implement it without loading the database driver.

export { LOCAL_KEK_VARIABLE, LocalKeyManager } from './local.js';
export type { LocalKeyManagerOptions } from './local.js';
export {
  KeyManagerInputError,
  KeyManagerRefusedError,
  KeyManagerUnavailableError,
  aadFields,
} from './port.js';
export type { KeyManager, KeyManagerCallOptions, KeyWrapAad, WrappedKey } from './port.js';
