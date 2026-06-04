use js_export_macro::js_export;
use miden_client::account::AccountType as NativeAccountType;

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
