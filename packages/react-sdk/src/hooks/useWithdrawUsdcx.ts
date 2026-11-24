import type {
  TransactionResult,
  TransactionStage,
  WithdrawUsdcxOptions,
} from "../types";

export interface UseWithdrawUsdcxResult {
  withdrawUsdcx: (options: WithdrawUsdcxOptions) => Promise<TransactionResult>;
  result: TransactionResult | null;
  isLoading: boolean;
  stage: TransactionStage;
  error: Error | null;
  reset: () => void;
}

export function useWithdrawUsdcx(): UseWithdrawUsdcxResult {
  return {
    withdrawUsdcx: async () => {
      throw new Error("not implemented");
    },
    result: null,
    isLoading: false,
    stage: "idle",
    error: null,
    reset: () => {},
  };
}
