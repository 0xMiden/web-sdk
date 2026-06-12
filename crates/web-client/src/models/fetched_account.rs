use js_export_macro::js_export;
use miden_client::account::Account as NativeAccount;
use miden_client::note::BlockNumber;
use miden_client::rpc::domain::account::AccountProof;

use super::account::Account;
use super::account_id::AccountId;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Account details returned by the node.
#[derive(Clone)]
#[js_export]
pub struct FetchedAccount {
    account_id: AccountId,
    commitment: Word,
    last_block_num: BlockNumber,
    account: Option<Account>,
}

#[js_export]
impl FetchedAccount {
    /// Returns the account ID.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.account_id
    }

    /// Returns the account commitment reported by the node.
    pub fn commitment(&self) -> Word {
        self.commitment.clone()
    }

    /// Returns the last block height where the account was updated.
    #[js_export(js_name = "lastBlockNum")]
    pub fn last_block_num(&self) -> u32 {
        self.last_block_num.as_u32()
    }

    /// Returns the full account data when the account is public.
    pub fn account(&self) -> Option<Account> {
        self.account.clone()
    }

    /// Returns true when the account is public.
    #[js_export(js_name = "isPublic")]
    pub fn is_public(&self) -> bool {
        self.account_id.is_public()
    }

    /// Returns true when the account is private.
    #[js_export(js_name = "isPrivate")]
    pub fn is_private(&self) -> bool {
        self.account_id.is_private()
    }
}

// CONVERSIONS
// ================================================================================================

impl FetchedAccount {
    /// Builds a [`FetchedAccount`] from an [`AccountProof`] returned by the node's `GetAccount`
    /// endpoint, paired with the block height the proof was taken at.
    ///
    /// The full account state is only present for public accounts; private accounts carry only
    /// their on-chain commitment, so `account` is left `None`.
    pub(crate) fn from_proof(
        block_num: BlockNumber,
        proof: AccountProof,
    ) -> Result<FetchedAccount, JsErr> {
        let account_id = proof.account_id();
        let commitment = proof.account_commitment();
        let account = match proof.into_details() {
            Some(details) => Some(
                NativeAccount::try_from(&details)
                    .map_err(|err| from_str_err(&err.to_string()))?
                    .into(),
            ),
            None => None,
        };

        Ok(FetchedAccount {
            account_id: account_id.into(),
            commitment: commitment.into(),
            last_block_num: block_num,
            account,
        })
    }
}
