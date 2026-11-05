// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The Postgres image, in a module of its own with no imports, so a script
// run directly by node can read it. A module that imports a sibling with a
// .js specifier cannot be loaded that way, and the type generator needs
// this one value.
//
// Pinned, and the same image the payouts spike already used, so a run needs
// no new pull. One tag everywhere means the server is identical on a
// developer machine and in CI, which is the opposite of the problem in
// qomiralabs/ujira#337, where a Linux only image hid a defect.
//
// By digest as well as tag: a tag can be pushed again with different contents,
// and a digest cannot. This is the multi-platform index, so the same pin works
// on every machine.
export const POSTGRES_IMAGE =
  'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
