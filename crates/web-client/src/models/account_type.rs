use js_export_macro::js_export;
use miden_client::account::AccountType as NativeAccountType;

/// Storage mode of an account. The 0.15 protocol collapses the previous
/// 4-way `{ FungibleFaucet, NonFungibleFaucet, RegularAccountImmutableCode,
/// RegularAccountUpdatableCode }` distinction into a 2-way storage flag —
/// faucet-vs-regular and updatable-vs-immutable distinctions are no longer
/// part of the on-chain `AccountType` and the API loses no information by
/// narrowing here too.
#[derive(Clone)]
#[js_export]
pub enum AccountType {
    Private,
    Public,
}

// CONVERSIONS
// ================================================================================================

impl From<AccountType> for NativeAccountType {
    fn from(value: AccountType) -> Self {
        match value {
            AccountType::Private => NativeAccountType::Private,
            AccountType::Public => NativeAccountType::Public,
        }
    }
}

impl From<&AccountType> for NativeAccountType {
    fn from(value: &AccountType) -> Self {
        match value {
            AccountType::Private => NativeAccountType::Private,
            AccountType::Public => NativeAccountType::Public,
        }
    }
}

impl From<NativeAccountType> for AccountType {
    fn from(value: NativeAccountType) -> Self {
        match value {
            NativeAccountType::Private => AccountType::Private,
            NativeAccountType::Public => AccountType::Public,
        }
    }
}
