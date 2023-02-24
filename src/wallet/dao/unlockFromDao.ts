import { render } from '@testing-library/react';
import { Cell, Script } from "@ckb-lumos/base";
import { since, helpers } from "@ckb-lumos/lumos";
import { dao, common } from "@ckb-lumos/common-scripts";
import { values } from "@ckb-lumos/base";
import { commons } from '@ckb-lumos/lumos';
import {
  TransactionSkeleton,
  TransactionSkeletonType,
  createTransactionFromSkeleton,
  sealTransaction
} from "@ckb-lumos/helpers";
import {
  filterDAOCells,
  isCellDeposit,
  getCurrentBlockHeader,
  getDepositDaoEarliestSince,
  getWithdrawDaoEarliestSince,
  findCorrectInputFromWithdrawCell,
  getTransactionFromHash,
  getBlockHeaderFromHash
} from "./index";
import { sendTransaction, signTransaction } from "../index";
import { DAOUnlockableAmount, FeeRate } from "../../type";
import owership from '../../owership';
import { DEPOSITDAODATA, RPC_NETWORK, TEST_INDEXER } from "../../config/index";
import { getTransactionSkeleton } from "../customCellProvider";
import { jsonToHump } from '../../utils/pubilc';

const { ScriptValue } = values;

export enum AddressScriptType {
  SECP256K1_BLAKE160 = "SECP256K1_BLAKE160",
  SUDT = "SUDT",
  DAO = "DAO"
}

export async function withdrawOrUnlock(
  unlockableAmount: DAOUnlockableAmount,
  address: string,
  // privKey: string,
  // script: Script,
  feeRate: FeeRate = FeeRate.NORMAL
): Promise<string> {
  const res = await owership.getLiveCells();
  // @ts-ignore
  const cells = await filterDAOCells(res.objects);

  const cell = await findCellFromUnlockableAmountAndCells(
    unlockableAmount,
    cells
  );

  if (!cell) {
    throw new Error("Cell related to unlockable amount not found!");
  }
  
  return withdrawOrUnlockFromCell(cell, address, feeRate);
}

async function findCellFromUnlockableAmountAndCells(
  unlockableAmount: DAOUnlockableAmount,
  cells: Cell[]
): Promise<Cell> {
  const filtCells = await filterDAOCells(cells);
  const capacity = `0x${unlockableAmount.amount.toString(16)}`;

  for (let i = 0; i < filtCells.length; i += 1) {
    if (
      filtCells[i].cellOutput.capacity === capacity &&
    // @ts-ignore
      filtCells[i].outPoint.txHash === unlockableAmount.txHash
    ) {
      return filtCells[i];
    }
  }

  // @ts-ignore
  return null;
}

async function withdrawOrUnlockFromCell(
  cell: Cell,
  address: string,
  feeRate: FeeRate = FeeRate.NORMAL
): Promise<string> {
  const feeAddresses = [address];

  // TODO Dao receives and writes his own address
  const to = feeAddresses[0];

  if (!isCellDeposit(cell)) {
    // Check real unlockability
    if (!(await isCellUnlockable(cell))) {
      throw new Error("Cell can not yet be unlocked.");
    }
    return unlock(
      cell,
      feeAddresses,
      feeRate
    );
  }

  return withdraw(cell, feeAddresses, feeRate);
}

async function isCellUnlockable(cell: Cell): Promise<boolean> {
  let sinceBI: bigint;
  const currentBlockHeader = await getCurrentBlockHeader();
  const currentEpoch = since.parseEpoch(currentBlockHeader.epoch);

  if (isCellDeposit(cell)) {
    sinceBI = await getDepositDaoEarliestSince(cell);
  } else {
    sinceBI = await getWithdrawDaoEarliestSince(cell);
  }
  const earliestSince = since.parseAbsoluteEpochSince(sinceBI.toString());

  const unlockable =
    currentEpoch.number > earliestSince.number ||
    (currentEpoch.number === earliestSince.number &&
      currentEpoch.index >= earliestSince.index);
  return unlockable;
}

async function withdraw(
  inputCell: Cell,
  feeAddresses: string[],
  feeRate: FeeRate = FeeRate.NORMAL
): Promise<string> {

  jsonToHump(inputCell)
  let txSkeleton = getTransactionSkeleton(await owership.getOffChainLocks());

  txSkeleton = await dao.withdraw(txSkeleton, inputCell, undefined, {
    config: RPC_NETWORK
  });

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    feeAddresses,
    feeRate,
    undefined,
    { config: RPC_NETWORK }
  );


  const localStorage = await window.localStorage.setItem("txSkeleton", JSON.stringify(txSkeleton))

  const txSkeletonWEntries = commons.common.prepareSigningEntries(txSkeleton, {
    config: RPC_NETWORK
  });


  const transaction = createTransactionFromSkeleton(txSkeleton);

  const groupedSignature = await owership.signTransaction(transaction);

  const tx = sealTransaction(txSkeletonWEntries, groupedSignature.map(([script,sign])=>{return sign}));

  // const signingPrivKeys = extractPrivateKeys(
  //   txSkeleton,
  //   feeAddresses,
  //   privateKeys
  // );
  // const sortedSignPKeys = [
  //   privateKey,
  //   ...signingPrivKeys.filter(pkey => pkey !== privateKey)
  // ];

  return sendTransaction(tx);
}

async function unlock(
  withdrawCell: Cell,
  feeAddresses: string[],
  feeRate: FeeRate = FeeRate.NORMAL
): Promise<string> {
  jsonToHump(withdrawCell)
  let txSkeleton = TransactionSkeleton({ cellProvider: TEST_INDEXER });

  const depositCell = await getDepositCellFromWithdrawCell(withdrawCell);

  if (!(await isCellUnlockable(withdrawCell))) {
    throw new Error("Cell can not be unlocked. Minimum time is 30 days.");
  }

  txSkeleton = await dao.unlock(
    txSkeleton,
    depositCell,
    withdrawCell,
    feeAddresses[0],
    feeAddresses[0],
    {
      config: RPC_NETWORK
      // RpcClient: RpcMocker as any
    }
  );

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    feeAddresses,
    feeRate,
    undefined,
    { config: RPC_NETWORK }
  );

  const localStorage = await window.localStorage.setItem("txSkeleton", JSON.stringify(txSkeleton))
  const txSkeletonWEntries = commons.common.prepareSigningEntries(txSkeleton, {
    config: RPC_NETWORK
  });

  const transaction = createTransactionFromSkeleton(txSkeleton);
  const groupedSignature = await owership.signTransaction(transaction);
  const tx = sealTransaction(txSkeletonWEntries, [groupedSignature[0][1]]);
  
  return sendTransaction(tx);

}

async function getDepositCellFromWithdrawCell(
  withdrawCell: Cell
): Promise<Cell> {
  const { index, txHash } = await findCorrectInputFromWithdrawCell(
    withdrawCell
  );

  const depositTransaction = await getTransactionFromHash(txHash);

  const depositBlockHeader = await getBlockHeaderFromHash(
    depositTransaction.txStatus.blockHash
  );

  return {
    cellOutput: {
      capacity: withdrawCell.cellOutput.capacity,
      lock: { ...withdrawCell.cellOutput.lock },
      // @ts-ignore
      type: { ...withdrawCell.cellOutput.type }
    },
    outPoint: {
      txHash: txHash,
      index
    },
    data: DEPOSITDAODATA,
    blockHash: depositBlockHeader.hash,
    blockNumber: depositBlockHeader.number
  };
}

function extractPrivateKeys(
  txSkeleton: TransactionSkeletonType,
  fromAddresses: string[],
  privateKeys: string[]
): string[] {
  const signingPrivKeys: string[] = [];

  for (let i = 0; i < fromAddresses.length; i += 1) {
    if (
      getScriptFirstIndex(txSkeleton, getLockFromAddress(fromAddresses[i])) !==
      -1
    ) {
      signingPrivKeys.push(privateKeys[i]);
    }
  }

  return signingPrivKeys;
}

function getScriptFirstIndex(
  txSkeleton: TransactionSkeletonType,
  fromScript: Script
): number {
  return txSkeleton
    .get("inputs")
    .findIndex((input: { cellOutput: { lock: any; }; }) =>
      new ScriptValue(input.cellOutput.lock, { validate: false }).equals(
        new ScriptValue(fromScript, { validate: false })
      )
    );
}

// Gets the locks script from an address
function getLockFromAddress(address: string): Script {
  return helpers.parseAddress(address, { config: RPC_NETWORK });
}

// function getNextAddress(): string {
//   return getAddress(firstRIndexWithoutTxs, AddressType.Receiving);
// }

// // Gets address from a specific accountId, addressType and script type
// function getAddress(accountId = 0, addressType: AddressType, script: AddressScriptType = AddressScriptType.SECP256K1_BLAKE160): string {
//     const key = `${accountId}-${addressType}-${script}`;
//     if (!this.addressMap[key]) {
//         const address = this.connection.getAddressFromLock(this.getLock(accountId, addressType, script));
//         this.addressMap[key] = address;
//     }

//     return this.addressMap[key];
// }
