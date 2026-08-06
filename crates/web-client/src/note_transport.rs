use js_export_macro::js_export;
use miden_client::Word;
use miden_client::note::{Note as NativeNote, NoteId};

use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Relay a private note through the note-transport layer with an explicit block hint.
    ///
    /// `scan_after_block_num` is the block from which the recipient starts scanning FORWARD for the
    /// note's on-chain commitment. It MUST be at or below the note's commitment block — a hint
    /// above the commitment is never scanned back to, so the recipient silently never receives
    /// the note. A safe, always-valid choice is the chain tip at the moment the note's
    /// transaction was submitted (the note cannot have committed earlier); a tighter value just
    /// means the recipient scans fewer blocks.
    ///
    /// For one of this client's own output notes, prefer [`WebClient::send_private_output_note`],
    /// which derives this block from the note's stored `expected_height` for you.
    #[js_export(js_name = "sendPrivateNote")]
    pub async fn send_private_note(
        &self,
        note: crate::models::note::Note,
        address: crate::models::address::Address,
        scan_after_block_num: u32,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        let native_note: NativeNote = note.into();

        client
            .send_private_note_with_block_hint(
                native_note,
                &address.into(),
                scan_after_block_num.into(),
            )
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private note"))?;

        Ok(())
    }

    /// Relay one of this client's own private output notes through the note-transport layer.
    ///
    /// The recipient's scan-start block is derived from the output note's stored `expected_height`
    /// (the chain tip when the note's transaction was submitted), so delivery is correct regardless
    /// of how far this client has since synced past the note — unlike a bare sync-height hint,
    /// which overshoots the commitment once the sender advances past it (e.g. relaying after
    /// waiting for the transaction to commit) and silently drops delivery. The note must exist
    /// in this client's store as an output note (i.e. its transaction has been submitted).
    #[js_export(js_name = "sendPrivateOutputNote")]
    pub async fn send_private_output_note(
        &self,
        note_id: String,
        address: crate::models::address::Address,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        let note_id: NoteId = NoteId::from_raw(
            Word::try_from(note_id)
                .map_err(|err| js_error_with_context(err, "failed to parse output note id"))?,
        );

        let record = client
            .get_output_note(note_id)
            .await
            .map_err(|e| js_error_with_context(e, "failed reading output note"))?
            .ok_or_else(|| from_str_err("No output note found for the given id"))?;

        let scan_after_block_num = record.expected_height();
        let native_note: NativeNote = record.try_into().map_err(|e| {
            js_error_with_context(e, "output note has no details to relay (recipient unknown)")
        })?;

        client
            .send_private_note_with_block_hint(native_note, &address.into(), scan_after_block_num)
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private output note"))?;

        Ok(())
    }

    /// Fetch private notes from the note transport layer
    ///
    /// Uses an internal pagination mechanism to avoid fetching duplicate notes.
    #[js_export(js_name = "fetchPrivateNotes")]
    pub async fn fetch_private_notes(&self) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        client
            .fetch_private_notes()
            .await
            .map_err(|e| js_error_with_context(e, "failed fetching private notes"))?;

        Ok(())
    }

    /// Fetch all private notes from the note transport layer
    ///
    /// Fetches all notes stored in the transport layer, with no pagination.
    /// Prefer using [`WebClient::fetch_private_notes`] for a more efficient, on-going,
    /// fetching mechanism.
    #[js_export(js_name = "fetchAllPrivateNotes")]
    pub async fn fetch_all_private_notes(&self) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        client
            .fetch_all_private_notes()
            .await
            .map_err(|e| js_error_with_context(e, "failed fetching all private notes"))?;

        Ok(())
    }
}
