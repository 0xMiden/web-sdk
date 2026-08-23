export const WorkerAction = Object.freeze({
  INIT: "init",
  INIT_MOCK: "initMock",
  INIT_THREAD_POOL: "initThreadPool",
  CALL_METHOD: "callMethod",
  EXECUTE_CALLBACK: "executeCallback",
});

export const CallbackType = Object.freeze({
  GET_KEY: "getKey",
  INSERT_KEY: "insertKey",
  SIGN: "sign",
});

export const MethodName = Object.freeze({
  CREATE_CLIENT: "createClient",
  APPLY_TRANSACTION: "applyTransaction",
  EXECUTE_TRANSACTION: "executeTransaction",
  EXECUTE_TRANSACTION_AT: "executeTransactionAt",
  PROVE_TRANSACTION: "proveTransaction",
  SUBMIT_NEW_TRANSACTION: "submitNewTransaction",
  SUBMIT_NEW_TRANSACTION_MOCK: "submitNewTransactionMock",
  // No mock counterpart — see MockWebClient.submitNewTransactionBatch.
  SUBMIT_NEW_TRANSACTION_BATCH: "submitNewTransactionBatch",
  SUBMIT_NEW_TRANSACTION_WITH_PROVER: "submitNewTransactionWithProver",
  SUBMIT_NEW_TRANSACTION_WITH_PROVER_MOCK: "submitNewTransactionWithProverMock",
  SYNC_STATE: "syncState",
  SYNC_STATE_MOCK: "syncStateMock",
  SYNC_CHAIN: "syncChain",
  SYNC_CHAIN_MOCK: "syncChainMock",
  SYNC_NOTE_TRANSPORT: "syncNoteTransport",
  SYNC_NOTE_TRANSPORT_MOCK: "syncNoteTransportMock",
});
