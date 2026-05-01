import { describe, it, expect } from "vitest";
import { WorkerAction, CallbackType, MethodName } from "../constants.js";

describe("WorkerAction", () => {
  it("has expected constant values", () => {
    expect(WorkerAction.INIT).toBe("init");
    expect(WorkerAction.INIT_MOCK).toBe("initMock");
    expect(WorkerAction.CALL_METHOD).toBe("callMethod");
    expect(WorkerAction.EXECUTE_CALLBACK).toBe("executeCallback");
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(WorkerAction)).toBe(true);
  });
});

describe("CallbackType", () => {
  it("has expected constant values", () => {
    expect(CallbackType.GET_KEY).toBe("getKey");
    expect(CallbackType.INSERT_KEY).toBe("insertKey");
    expect(CallbackType.SIGN).toBe("sign");
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(CallbackType)).toBe(true);
  });
});

describe("MethodName", () => {
  it("has expected constant values", () => {
    expect(MethodName.CREATE_CLIENT).toBe("createClient");
    expect(MethodName.APPLY_TRANSACTION).toBe("applyTransaction");
    expect(MethodName.EXECUTE_TRANSACTION).toBe("executeTransaction");
    expect(MethodName.PROVE_TRANSACTION).toBe("proveTransaction");
    expect(MethodName.SUBMIT_NEW_TRANSACTION).toBe("submitNewTransaction");
    expect(MethodName.SUBMIT_NEW_TRANSACTION_MOCK).toBe(
      "submitNewTransactionMock"
    );
    expect(MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER).toBe(
      "submitNewTransactionWithProver"
    );
    expect(MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER_MOCK).toBe(
      "submitNewTransactionWithProverMock"
    );
    expect(MethodName.SYNC_STATE).toBe("syncState");
    expect(MethodName.SYNC_STATE_MOCK).toBe("syncStateMock");
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(MethodName)).toBe(true);
  });
});
