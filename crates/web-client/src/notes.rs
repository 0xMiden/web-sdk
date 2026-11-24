use js_export_macro::js_export;
use miden_client::Word;
use miden_client::note::NoteId;

use crate::models::account_id::AccountId;
use crate::models::consumable_note_record::{ConsumableNoteRecord, NoteConsumability};
use crate::models::input_note_page::InputNotePageResult;
use crate::models::input_note_record::InputNoteRecord;
use crate::models::note::Note;
use crate::models::note_filter::NoteFilter;
use crate::models::output_note_record::OutputNoteRecord;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Scans at most `limit` raw input-note rows before selecting states.
    ///
    /// Browser-only, using the existing store. Omitted states select every state;
    /// the default limit is 128 and the maximum is 256. The exclusive cursor is a
    /// canonical details commitment, independent of optional note IDs.
    #[js_export(js_name = "getInputNotesPage")]
    pub async fn get_input_notes_page(
        &self,
        states: Option<Vec<u8>>,
        after_details_commitment: Option<String>,
        limit: Option<f64>,
    ) -> Result<InputNotePageResult, JsErr> {
        #[cfg(feature = "nodejs")]
        {
            let _ = (states, after_details_commitment, limit);
            Err(from_str_err("Input note paging is browser-only; native Node is unsupported"))
        }
        #[cfg(feature = "browser")]
        {
            let limit = limit.unwrap_or(128.0);
            if !(1.0..=256.0).contains(&limit) || limit.fract() != 0.0 {
                return Err(from_str_err(
                    "Input note page limit must be an integer between 1 and 256",
                ));
            }
            // The range and integer checks above restrict this value to 1-256.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let limit = limit as u32;
            let guard = self.get_mut_inner().await;
            let client = guard.as_ref().ok_or_else(|| from_str_err("Client not initialized"))?;
            let page = idxdb_store::note::get_input_notes_page_by_db_id(
                client.store_identifier(),
                states.unwrap_or_default(),
                after_details_commitment,
                limit,
            )
            .await
            .map_err(|err| js_error_with_context(err, "failed to get input note page"))?;
            Ok(InputNotePageResult {
                notes: page.notes.into_iter().map(Into::into).collect(),
                next_cursor: page.next_cursor,
                exhausted: page.exhausted,
            })
        }
    }

    #[js_export(js_name = "getInputNotes")]
    pub async fn get_input_notes(&self, filter: NoteFilter) -> Result<Vec<InputNoteRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let result = client
            .get_input_notes(filter.try_into()?)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get input notes"))?;
        Ok(result.into_iter().map(Into::into).collect())
    }

    #[js_export(js_name = "getInputNote")]
    pub async fn get_input_note(&self, note_id: String) -> Result<Option<InputNoteRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let note_id: NoteId = NoteId::from_raw(
            Word::try_from(note_id)
                .map_err(|err| js_error_with_context(err, "failed to parse input note id"))?,
        );
        let result = client
            .get_input_note(note_id)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get input note"))?;

        Ok(result.map(Into::into))
    }

    #[js_export(js_name = "getOutputNotes")]
    pub async fn get_output_notes(
        &self,
        filter: NoteFilter,
    ) -> Result<Vec<OutputNoteRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let notes = client
            .get_output_notes(filter.try_into()?)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get output notes"))?;
        Ok(notes.into_iter().map(Into::into).collect())
    }

    #[js_export(js_name = "getOutputNote")]
    pub async fn get_output_note(&self, note_id: String) -> Result<OutputNoteRecord, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let note_id: NoteId = NoteId::from_raw(
            Word::try_from(note_id)
                .map_err(|err| js_error_with_context(err, "failed to parse output note id"))?,
        );
        let note = client
            .get_output_note(note_id)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get output note"))?
            .ok_or_else(|| from_str_err("Note not found"))?;

        Ok(note.into())
    }

    /// Lists the notes the account can consume.
    ///
    /// Consumable means a trial transaction consuming the note with the account
    /// succeeded at the last sync. It does not mean the note pays the account:
    /// consuming runs the note's script, which can also spend from the account.
    /// Check `isStandardPayment(record)` to find P2ID and P2IDE payments, or use
    /// `notes.listAvailable`.
    #[js_export(js_name = "getConsumableNotes")]
    pub async fn get_consumable_notes(
        &self,
        account_id: Option<AccountId>,
    ) -> Result<Vec<ConsumableNoteRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_account_id = account_id.map(Into::into);
        let result = Box::pin(client.get_consumable_notes(native_account_id))
            .await
            .map_err(|err| js_error_with_context(err, "failed to get consumable notes"))?;

        Ok(result.into_iter().map(Into::into).collect())
    }

    /// Screens a note the client has not imported against every account it tracks, with the
    /// screener sync uses. The note is not stored.
    ///
    /// Returns one entry per account that can consume the note now, after a block, or with
    /// authorization. A note no tracked account can consume returns an empty array: the screener
    /// drops never-consumable results and results that fail under the current conditions.
    #[js_export(js_name = "getNoteConsumability")]
    pub async fn get_note_consumability(
        &self,
        note: &Note,
    ) -> Result<Vec<NoteConsumability>, JsErr> {
        let note = note.0.clone();
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let result = Box::pin(client.note_screener().get_consumability(&note))
            .await
            .map_err(|err| js_error_with_context(err, "failed to screen note"))?;
        Ok(result.into_iter().map(Into::into).collect())
    }

    /// Screens a note the client has not imported against one account, as
    /// [`WebClient::get_note_consumability`] does. The account must be in the client's store.
    ///
    /// Returns a single entry for that account, or an empty array when it cannot consume the note.
    #[js_export(js_name = "getNoteConsumabilityForAccount")]
    pub async fn get_note_consumability_for_account(
        &self,
        note: &Note,
        account_id: &AccountId,
    ) -> Result<Vec<NoteConsumability>, JsErr> {
        let note = note.0.clone();
        let account_id: miden_client::account::AccountId = account_id.into();
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let mut result = Box::pin(
            client
                .note_screener()
                .get_batch_consumability_for_account(account_id, core::slice::from_ref(&note)),
        )
        .await
        .map_err(|err| js_error_with_context(err, "failed to screen note"))?;
        Ok(result
            .remove(&note.id())
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect())
    }
}
