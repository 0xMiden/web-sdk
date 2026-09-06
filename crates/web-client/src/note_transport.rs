use js_export_macro::js_export;
use miden_client::note::NoteId;
use miden_client::Client;

use crate::platform::{ClientAuth, JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

async fn note_commitment_block_hint(
    client: &mut Client<ClientAuth>,
    note_id: NoteId,
) -> Result<Option<u32>, JsErr> {
    if let Ok(Some(record)) = client.get_output_note(note_id).await {
        if let Some(proof) = record.inclusion_proof() {
            return Ok(Some(proof.location().block_num().as_u32()));
        }
    }

    if let Ok(Some(record)) = client.get_input_note(note_id).await {
        if let Some(proof) = record.inclusion_proof() {
            return Ok(Some(proof.location().block_num().as_u32()));
        }
    }

    Ok(None)
}

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

        // Relay with a block hint so the recipient scans from a deterministic block for the note's
        // on-chain commitment, instead of the narrow fixed lookback window it falls back to for
        // hint-less notes. That window silently drops the note for any recipient whose sync height
        // has advanced past it, so hint-less delivery is non-deterministic.
        //
        // Prefer the note's on-chain commitment block when the sender's store already has an
        // inclusion proof (exact hint). Fall back to the sender's current sync height for the
        // prompt-relay-before-commit path, where sync height is still below the commitment.
        let note_id: NoteId = note.id().into();
        let block_hint = match note_commitment_block_hint(client, note_id).await? {
            Some(block_num) => block_num,
            None => client
                .get_sync_height()
                .await
                .map_err(|e| js_error_with_context(e, "failed reading block hint for private note"))?,
        };

        client
            .send_private_note_with_block_hint(note.into(), &address.into(), block_hint)
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
