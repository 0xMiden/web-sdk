use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::AccountProcedureRoot;
use miden_client::account::component::ApproverSet;
use miden_client::auth::{
    Approver,
    AuthGuardedMultisig as NativeAuthGuardedMultisig,
    AuthGuardedMultisigConfig as NativeAuthGuardedMultisigConfig,
    AuthSchemeId as NativeAuthSchemeId,
    GuardianConfig as NativeGuardianConfig,
    PublicKeyCommitment,
};

use crate::js_error_with_context;
use crate::models::account_component::AccountComponent;
use crate::models::auth_scheme::AuthScheme;
use crate::models::components::auth_falcon512_rpo_multisig::ProcedureThreshold;
use crate::models::word::Word;
use crate::platform::JsErr;

/// Guarded-multisig auth configuration: an approver set plus the guardian that co-signs.
#[js_export]
#[derive(Clone)]
pub struct AuthGuardedMultisigConfig(NativeAuthGuardedMultisigConfig);

#[js_export]
impl AuthGuardedMultisigConfig {
    /// Build a configuration from approver public key commitments, a default threshold, the
    /// guardian's public key commitment, and the signature scheme they all use.
    ///
    /// `default_threshold` must be >= 1 and <= `approvers.length`, and the guardian key must
    /// differ from every approver key. The scheme applies to every approver and to the guardian;
    /// mixed-scheme approver sets are not expressible here.
    #[js_export(constructor)]
    pub fn new(
        approvers: Vec<Word>,
        default_threshold: u32,
        guardian: &Word,
        auth_scheme: AuthScheme,
    ) -> Result<AuthGuardedMultisigConfig, JsErr> {
        let scheme: NativeAuthSchemeId = auth_scheme.try_into()?;

        let native_approvers: Vec<Approver> = approvers
            .into_iter()
            .map(|word| {
                let native_word: NativeWord = word.into();
                Approver::new(PublicKeyCommitment::from(native_word), scheme)
            })
            .collect();

        let approver_set = ApproverSet::new(native_approvers, default_threshold)
            .map_err(|e| js_error_with_context(e, "Invalid guarded multisig config"))?;

        let guardian_word: NativeWord = guardian.clone().into();
        let guardian_config = NativeGuardianConfig::new(Approver::new(
            PublicKeyCommitment::from(guardian_word),
            scheme,
        ));

        let config = NativeAuthGuardedMultisigConfig::new(approver_set, guardian_config)
            .map_err(|e| js_error_with_context(e, "Invalid guarded multisig config"))?;

        Ok(AuthGuardedMultisigConfig(config))
    }

    /// Attach per-procedure thresholds. Each threshold must be >= 1 and <= `approvers.length`.
    #[js_export(js_name = "withProcThresholds")]
    pub fn with_proc_thresholds(
        &self,
        proc_thresholds: Vec<ProcedureThreshold>,
    ) -> Result<AuthGuardedMultisigConfig, JsErr> {
        let native_proc_thresholds = proc_thresholds
            .into_iter()
            .map(|entry| {
                let proc_root: NativeWord = entry.proc_root().into();
                (AccountProcedureRoot::from_raw(proc_root), entry.threshold())
            })
            .collect();

        let config = self
            .0
            .clone()
            .with_proc_thresholds(native_proc_thresholds)
            .map_err(|e| js_error_with_context(e, "Invalid per-procedure thresholds"))?;

        Ok(AuthGuardedMultisigConfig(config))
    }

    #[js_export(getter, js_name = "defaultThreshold")]
    pub fn default_threshold(&self) -> u32 {
        self.0.default_threshold()
    }

    /// Approver public key commitments as Words.
    #[js_export(getter)]
    pub fn approvers(&self) -> Vec<Word> {
        self.0
            .approvers()
            .iter()
            .map(|approver| {
                let word: NativeWord = approver.pub_key().into();
                word.into()
            })
            .collect()
    }
}

/// Create the standard guarded-multisig auth component.
///
/// This returns the upstream `miden::standards::auth::guarded_multisig` component, statically
/// linked exactly as the Rust client builds it. Compiling an equivalent MASM source through
/// `AccountComponent.compile` instead links it dynamically, which yields a different `auth_tx`
/// procedure root; `AccountComponentInterface::from_procedures` then fails to classify the
/// account, and the client silently declines to attach fee conversion info to its transactions.
#[cfg_attr(
    feature = "browser",
    wasm_bindgen::prelude::wasm_bindgen(js_name = "createAuthGuardedMultisig")
)]
#[cfg_attr(feature = "nodejs", napi_derive::napi(js_name = "createAuthGuardedMultisig"))]
pub fn create_auth_guarded_multisig(
    config: AuthGuardedMultisigConfig,
) -> Result<AccountComponent, JsErr> {
    let native_config: NativeAuthGuardedMultisigConfig = config.into();

    let guarded = NativeAuthGuardedMultisig::new(native_config).map_err(|e| {
        js_error_with_context(e, "Failed to create guarded multisig auth component")
    })?;

    let native_component: miden_client::account::AccountComponent = guarded.into();

    Ok(native_component.into())
}

impl From<AuthGuardedMultisigConfig> for NativeAuthGuardedMultisigConfig {
    fn from(config: AuthGuardedMultisigConfig) -> Self {
        config.0
    }
}

impl_napi_from_value!(AuthGuardedMultisigConfig);
