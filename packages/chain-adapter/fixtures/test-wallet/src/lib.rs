// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

//! A smart wallet with one ed25519 owner key, so the adapter's testnet test
//! can act as a C principal and sign authorization entries the way a real
//! smart wallet would.

#![no_std]

use soroban_sdk::{
    auth::Context, contract, contracterror, contractimpl, crypto::Hash, symbol_short, BytesN, Env,
    Symbol, Vec,
};

const OWNER: Symbol = symbol_short!("owner");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum WalletError {
    NoOwner = 1,
}

#[contract]
pub struct TestWallet;

#[contractimpl]
impl TestWallet {
    pub fn __constructor(env: Env, owner: BytesN<32>) {
        env.storage().instance().set(&OWNER, &owner);
    }

    /// Accepts a signature by the owner key over the authorization payload.
    /// The host traps on a bad signature, so nothing else needs checking.
    #[allow(non_snake_case)]
    pub fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), WalletError> {
        let owner: BytesN<32> = env
            .storage()
            .instance()
            .get(&OWNER)
            .ok_or(WalletError::NoOwner)?;
        env.crypto()
            .ed25519_verify(&owner, &signature_payload.to_bytes().into(), &signature);
        Ok(())
    }
}
