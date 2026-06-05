use miden_client::account::component::{AccountComponent, BasicWallet};
use miden_client::account::{Account, AccountBuilder, AccountBuilderSchemaCommitmentExt};
use miden_client::auth::{AuthSchemeId as NativeAuthScheme, AuthSecretKey, AuthSingleSig};
use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};

use crate::js_error_with_context;
use crate::models::account_storage_mode::AccountStorageMode;
use crate::models::auth::AuthScheme;
use crate::platform::{JsErr, from_str_err};

// HELPERS
// ================================================================================================
// These methods should not be exposed to the wasm interface

/// Serves as a way to manage the logic of seed generation.
///
/// # Errors:
/// - If rust client calls fail
/// - If the seed is passed in and is not exactly 32 bytes
pub(crate) async fn generate_wallet(
    storage_mode: &AccountStorageMode,
    mutable: bool,
    seed: Option<Vec<u8>>,
    auth_scheme: AuthScheme,
) -> Result<(Account, AuthSecretKey), JsErr> {
    let mut rng = match seed {
        Some(seed_bytes) => {
            // Attempt to convert the seed slice into a 32-byte array.
            let seed_array: [u8; 32] = seed_bytes
                .try_into()
                .map_err(|_| from_str_err("Seed must be exactly 32 bytes"))?;
            StdRng::from_seed(seed_array)
        },
        None => StdRng::from_os_rng(),
    };

    let native_scheme: NativeAuthScheme = auth_scheme.try_into()?;
    let key_pair = match native_scheme {
        NativeAuthScheme::Falcon512Poseidon2 => {
            AuthSecretKey::new_falcon512_poseidon2_with_rng(&mut rng)
        },
        NativeAuthScheme::EcdsaK256Keccak => {
            AuthSecretKey::new_ecdsa_k256_keccak_with_rng(&mut rng)
        },
        _ => {
            let message = format!("unsupported auth scheme: {native_scheme:?}");
            return Err(from_str_err(&message));
        },
    };
    let auth_component: AccountComponent =
        AuthSingleSig::new(key_pair.public_key().to_commitment(), native_scheme).into();

    // The `mutable` parameter is preserved at the JS surface but has no
    // effect on the 0.15 protocol: the `RegularAccountUpdatableCode` vs
    // `RegularAccountImmutableCode` distinction was removed (the on-chain
    // `AccountType` is now just `Private` / `Public` — i.e. storage mode).
    // Discarded here with `_` so existing callers don't break.
    let _ = mutable;
    let mut init_seed = [0u8; 32];
    rng.fill_bytes(&mut init_seed);

    // `AccountBuilder::storage_mode` was folded into `account_type` in 0.15;
    // `AccountStorageMode` from web-sdk maps directly onto the new 2-way
    // `AccountType { Private, Public }` via its `Into<NativeAccountType>` impl.
    let new_account = AccountBuilder::new(init_seed)
        .account_type(storage_mode.into())
        .with_auth_component(auth_component)
        .with_component(BasicWallet)
        .build_with_schema_commitment()
        .map_err(|err| js_error_with_context(err, "failed to create new wallet"))?;

    let _account_seed =
        new_account.seed().expect("newly built wallet should always contain a seed");

    Ok((new_account, key_pair))
}
