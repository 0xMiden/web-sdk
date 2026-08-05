use js_export_macro::js_export;
use miden_client::note::Note as NativeNote;

use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Send a private note via the note transport layer
    #[js_export(js_name = "sendPrivateNote")]
    pub async fn send_private_note(
        &self,
        note: crate::models::note::Note,
        address: crate::models::address::Address,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        let native_note: NativeNote = note.into();
        let note_id = native_note.id();

        // Relay with a block hint so the recipient scans from a deterministic block for the note's
        // on-chain commitment, instead of the narrow fixed lookback window it falls back to for
        // hint-less notes (that window silently drops the note for any recipient whose sync height
        // has advanced past it).
        //
        // Prefer the note's ACTUAL commitment block, read from its committed record's inclusion
        // proof, so for a note this client tracks (its own output note, or a held input note) the
        // hint is exact regardless of how far the sender has synced past it. The recipient scans
        // FORWARD from `after_block_num`, so a hint ABOVE the commitment — which a bare sync-height
        // hint produces once the sender has synced past the note (e.g. relaying after waiting for
        // commit) — is never scanned back to and silently drops delivery. With no inclusion proof
        // (note not committed yet, or not tracked here) fall back to the sync height: below the
        // commitment on the prompt-relay-before-commit path, best-effort otherwise.
        //
        // Propagate a genuine store read error instead of folding it into the not-committed path —
        // swallowing it would fall back to the sync height, which for an already-committed note the
        // sender has synced past sits ABOVE the commitment and silently drops delivery.
        let committed_block = {
            let from_output = client
                .get_output_note(note_id)
                .await
                .map_err(|e| js_error_with_context(e, "failed reading output note for block hint"))?
                .and_then(|record| {
                    record.inclusion_proof().map(|proof| proof.location().block_num())
                });
            match from_output {
                Some(block) => Some(block),
                None => client
                    .get_input_note(note_id)
                    .await
                    .map_err(|e| {
                        js_error_with_context(e, "failed reading input note for block hint")
                    })?
                    .and_then(|record| {
                        record.inclusion_proof().map(|proof| proof.location().block_num())
                    }),
            }
        };

        let block_hint = match committed_block {
            Some(block) => block,
            None => client.get_sync_height().await.map_err(|e| {
                js_error_with_context(e, "failed reading block hint for private note")
            })?,
        };

        client
            .send_private_note_with_block_hint(native_note, &address.into(), block_hint)
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private note"))?;

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
