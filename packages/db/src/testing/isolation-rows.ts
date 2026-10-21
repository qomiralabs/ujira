// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two markers, one per test file, so each file can write its own and look
// for the other's. Finding the other would mean the two files shared a
// database, which is what the harness exists to prevent.

export const THIS_FILE_ROW = 'written-by-harness-test';
export const OTHER_FILE_ROW = 'written-by-isolation-test';
