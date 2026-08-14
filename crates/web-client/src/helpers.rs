use miden_client::account::component::{
    AccountComponent,
    BasicWallet,
    BurnPolicy,
    FungibleFaucet,
    MintPolicy,
    TokenName,
    TokenPolicyManager,
};
use miden_client::account::{Account, AccountBuilder, AccountBuilderSchemaCommitmentExt};
use miden_client::asset::{AssetAmount, TokenSymbol};
use miden_client::auth::{
    Approver,
    AuthSchemeId as NativeAuthScheme,
    AuthSecretKey,
    AuthSingleSig,
};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

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
        None => rand::make_rng(),
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
    let approver = Approver::new(key_pair.public_key().to_commitment(), native_scheme);
    let auth_component: AccountComponent = AuthSingleSig::new(approver).into();

    let mut init_seed = [0u8; 32];
    rng.fill_bytes(&mut init_seed);

    // `AccountStorageMode` maps onto `AccountType { Private, Public }` via its
    // `Into<NativeAccountType>` impl — the storage mode *is* the account type.
    let new_account = AccountBuilder::new(init_seed)
        .account_type(storage_mode.into())
        .with_component(auth_component)
        .with_component(BasicWallet)
        .build_with_schema_commitment()
        .map_err(|err| js_error_with_context(err, "failed to create new wallet"))?;

    let _account_seed =
        new_account.seed().expect("newly built wallet should always contain a seed");

    Ok((new_account, key_pair))
}

/// Builds a fungible faucet account together with its authentication key.
///
/// A faucet is assembled from a [`FungibleFaucet`] component plus a [`TokenPolicyManager`]. Only
/// mint and burn policies are registered: registering transfer (send/receive) policies installs
/// asset-callback slots on the faucet, which forces minted `FungibleAsset`s to carry an enabled
/// callback flag and breaks the standard mint path. Mirrors the faucet construction used by the
/// rust-client test utilities.
///
/// # Errors:
/// - If the token name / symbol / max supply are invalid
/// - If the auth scheme is unsupported
/// - If the rust client account builder fails
pub(crate) async fn generate_faucet(
    storage_mode: &AccountStorageMode,
    token_name: String,
    token_symbol: String,
    decimals: u8,
    max_supply: u64,
    auth_scheme: AuthScheme,
) -> Result<(Account, AuthSecretKey), JsErr> {
    let mut rng: StdRng = rand::make_rng();

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
    let approver = Approver::new(key_pair.public_key().to_commitment(), native_scheme);
    let auth_component: AccountComponent = AuthSingleSig::new(approver).into();

    let symbol = TokenSymbol::new(&token_symbol).map_err(|err| from_str_err(&err.to_string()))?;
    let name = TokenName::new(&token_name).map_err(|err| from_str_err(&err.to_string()))?;
    let max_supply = AssetAmount::new(max_supply).map_err(|err| from_str_err(&err.to_string()))?;
    let faucet = FungibleFaucet::builder()
        .name(name)
        .symbol(symbol)
        .decimals(decimals)
        .max_supply(max_supply)
        .build()
        .map_err(|err| js_error_with_context(err, "failed to build fungible faucet"))?;

    // Only mint/burn policies are registered — see the function rustdoc for why transfer
    // policies are intentionally omitted.
    let policy_manager = TokenPolicyManager::builder()
        .active_mint_policy(MintPolicy::allow_all())
        .active_burn_policy(BurnPolicy::allow_all())
        .build();

    let mut init_seed = [0u8; 32];
    rng.fill_bytes(&mut init_seed);

    let new_account = AccountBuilder::new(init_seed)
        .account_type(storage_mode.into())
        .with_component(auth_component)
        .with_component(faucet)
        .with_components(policy_manager)
        .build_with_schema_commitment()
        .map_err(|err| js_error_with_context(err, "failed to create new faucet"))?;

    Ok((new_account, key_pair))
}
