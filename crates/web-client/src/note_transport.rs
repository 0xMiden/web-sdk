use js_export_macro::js_export;
use miden_client::Word;
use miden_client::note::{Note as NativeNote, NoteId};

use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Relay a private note through the note-transport layer with its inclusion proof.
    ///
    /// The transport verifies `inclusion_proof` and tells the recipient to scan from that
    /// block. The proof exists once the creating transaction is committed and this client has
    /// synced past it. For one of this client's own output notes, prefer
    /// [`WebClient::send_private_output_note`], which reads the stored proof.
    ///
    /// A rejection means the note did not reach the transport or the outcome is not known, and
    /// it is final: the client keeps no queue and no sync sends the note again. Transient
    /// transport failures are already retried within the call, as the client's
    /// `noteTransportMaxRetries` option sets. To try again later, send the same note again; a
    /// send is idempotent by note id.
    #[js_export(js_name = "sendPrivateNote")]
    pub async fn send_private_note(
        &self,
        note: crate::models::note::Note,
        address: crate::models::address::Address,
        inclusion_proof: crate::models::note_inclusion_proof::NoteInclusionProof,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        let native_note: NativeNote = note.into();

        client
            .send_private_note_with_proof(native_note, &address.into(), inclusion_proof.into())
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private note"))?;

        Ok(())
    }

    /// Relay one of this client's own private output notes through the note-transport layer.
    ///
    /// The inclusion proof is the one sync stored on the output note. It is absent until this
    /// client has synced past the block that committed the note, and the call fails in that
    /// case rather than relaying a note the recipient cannot locate. The note must exist in
    /// this client's store as an output note (its transaction has been applied).
    ///
    /// A rejection means the note did not reach the transport or the outcome is not known, and
    /// it is final: the client keeps no queue and no sync sends the note again. Transient
    /// transport failures are already retried within the call, as the client's
    /// `noteTransportMaxRetries` option sets. To try again later, call this again with the same
    /// note id; a send is idempotent by note id.
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

        // Clone before `try_into` consumes the record. The proof is what the recipient scans
        // from; it is not filled in until sync has passed the commitment block.
        let proof = record.inclusion_proof().cloned().ok_or_else(|| {
            from_str_err(
                "output note has no inclusion proof; sync past the block that committed it",
            )
        })?;
        let native_note: NativeNote = record.try_into().map_err(|e| {
            js_error_with_context(e, "output note has no details to relay (recipient unknown)")
        })?;

        client
            .send_private_note_with_proof(native_note, &address.into(), proof)
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private output note"))?;

        Ok(())
    }

    /// Fetch private notes from the note transport layer
    ///
    /// Uses an internal pagination mechanism to avoid fetching duplicate notes: only notes past
    /// the stored cursor are fetched. Historical notes for a newly tracked tag sit below that
    /// cursor and are recovered automatically during `syncState`, which backfills each new tag.
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
}
