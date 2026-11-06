//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Arena
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 *
 */
export const arenaAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'usdc_', internalType: 'contract IERC20', type: 'address' },
      { name: 'owner_', internalType: 'address', type: 'address' },
      { name: 'operator_', internalType: 'address', type: 'address' },
      { name: 'epochCap_', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'BPS',
    outputs: [{ name: '', internalType: 'uint16', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_AWARDS_PER_EPOCH',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'acceptOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'availablePool',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256' },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'awardOf',
    outputs: [{ name: 'amount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', internalType: 'uint256', type: 'uint256' }],
    name: 'claim',
    outputs: [{ name: 'amount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256' },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'claimed',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'entryId', internalType: 'uint256', type: 'uint256' }],
    name: 'entries',
    outputs: [
      { name: 'roundId', internalType: 'uint64', type: 'uint64' },
      { name: 'trader', internalType: 'address', type: 'address' },
      { name: 'outcome', internalType: 'enum Arena.Outcome', type: 'uint8' },
      { name: 'pnlBps', internalType: 'int32', type: 'int32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'entryCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'roundId', internalType: 'uint256', type: 'uint256' },
      { name: 'trader', internalType: 'address', type: 'address' },
    ],
    name: 'entryOf',
    outputs: [{ name: 'entryId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'epochCap',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epoch', internalType: 'uint256', type: 'uint256' }],
    name: 'epochPublished',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'amount', internalType: 'uint256', type: 'uint256' }],
    name: 'fund',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'humanOf',
    outputs: [{ name: 'humanId', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'roundId', internalType: 'uint256', type: 'uint256' }],
    name: 'lockPredictions',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'roundId', internalType: 'uint256', type: 'uint256' },
      { name: 'trader', internalType: 'address', type: 'address' },
    ],
    name: 'openEntry',
    outputs: [{ name: 'entryId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'operator',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'humanId', internalType: 'bytes32', type: 'bytes32' }],
    name: 'ownerOfHuman',
    outputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pendingOwner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'poolBalance',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256' },
      { name: 'yes', internalType: 'bool', type: 'bool' },
      { name: 'probYesBps', internalType: 'uint16', type: 'uint16' },
      { name: 'zeroGRequestIdHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'predict',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256' },
      { name: 'predictor', internalType: 'address', type: 'address' },
    ],
    name: 'predictions',
    outputs: [
      { name: 'exists', internalType: 'bool', type: 'bool' },
      { name: 'yes', internalType: 'bool', type: 'bool' },
      { name: 'probYesBps', internalType: 'uint16', type: 'uint16' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256' },
      { name: 'humanIds', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    name: 'publishEpoch',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'agent', internalType: 'address', type: 'address' },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'registerAgent',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner_', internalType: 'address', type: 'address' },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'registerOwner',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256' },
      { name: 'outcome', internalType: 'enum Arena.Outcome', type: 'uint8' },
      { name: 'pnlBps', internalType: 'int256', type: 'int256' },
    ],
    name: 'resolveEntry',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'roundId', internalType: 'uint256', type: 'uint256' }],
    name: 'roundLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'a', internalType: 'address', type: 'address' },
      { name: 'b', internalType: 'address', type: 'address' },
    ],
    name: 'sameHuman',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'epochCap_', internalType: 'uint256', type: 'uint256' }],
    name: 'setEpochCap',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'operator_', internalType: 'address', type: 'address' }],
    name: 'setOperator',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalAllocated',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'usdc',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdrawUnallocated',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'agent', internalType: 'address', type: 'address', indexed: true },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32', indexed: true },
    ],
    name: 'AgentRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Awarded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Claimed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'roundId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'trader', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'EntryOpened',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'outcome', internalType: 'enum Arena.Outcome', type: 'uint8', indexed: false },
      { name: 'pnlBps', internalType: 'int256', type: 'int256', indexed: false },
    ],
    name: 'EntryResolved',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [{ name: 'epochCap', internalType: 'uint256', type: 'uint256', indexed: false }],
    name: 'EpochCapChanged',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'epoch', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'total', internalType: 'uint256', type: 'uint256', indexed: false },
      { name: 'awards', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'EpochPublished',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [{ name: 'operator', internalType: 'address', type: 'address', indexed: true }],
    name: 'OperatorChanged',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address', indexed: true },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32', indexed: true },
    ],
    name: 'OwnerRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'previousOwner', internalType: 'address', type: 'address', indexed: true },
      { name: 'newOwner', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'OwnershipTransferStarted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'previousOwner', internalType: 'address', type: 'address', indexed: true },
      { name: 'newOwner', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'PoolFunded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'predictor', internalType: 'address', type: 'address', indexed: true },
      { name: 'humanId', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'yes', internalType: 'bool', type: 'bool', indexed: false },
      { name: 'probYesBps', internalType: 'uint16', type: 'uint16', indexed: false },
      { name: 'zeroGRequestIdHash', internalType: 'bytes32', type: 'bytes32', indexed: false },
    ],
    name: 'Predicted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [{ name: 'roundId', internalType: 'uint256', type: 'uint256', indexed: true }],
    name: 'PredictionsLocked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      { name: 'amount', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Withdrawn',
  },
  {
    type: 'error',
    inputs: [
      { name: 'entryId', internalType: 'uint256', type: 'uint256' },
      { name: 'predictor', internalType: 'address', type: 'address' },
    ],
    name: 'AlreadyPredicted',
  },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'AlreadyRegistered',
  },
  {
    type: 'error',
    inputs: [{ name: 'humanId', internalType: 'bytes32', type: 'bytes32' }],
    name: 'DuplicateAward',
  },
  {
    type: 'error',
    inputs: [
      { name: 'roundId', internalType: 'uint256', type: 'uint256' },
      { name: 'trader', internalType: 'address', type: 'address' },
    ],
    name: 'EntryExists',
  },
  {
    type: 'error',
    inputs: [{ name: 'entryId', internalType: 'uint256', type: 'uint256' }],
    name: 'EntryNotPending',
  },
  {
    type: 'error',
    inputs: [{ name: 'epoch', internalType: 'uint256', type: 'uint256' }],
    name: 'EpochAlreadyPublished',
  },
  {
    type: 'error',
    inputs: [{ name: 'humanId', internalType: 'bytes32', type: 'bytes32' }],
    name: 'HumanHasOwner',
  },
  {
    type: 'error',
    inputs: [
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
      { name: 'available', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'InsufficientPool',
  },
  { type: 'error', inputs: [], name: 'InvalidOutcome' },
  { type: 'error', inputs: [], name: 'InvalidProbability' },
  { type: 'error', inputs: [], name: 'LengthMismatch' },
  {
    type: 'error',
    inputs: [{ name: 'caller', internalType: 'address', type: 'address' }],
    name: 'NotHumanOwner',
  },
  { type: 'error', inputs: [], name: 'NotOperator' },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'NotRegistered',
  },
  { type: 'error', inputs: [], name: 'NothingToClaim' },
  {
    type: 'error',
    inputs: [
      { name: 'total', internalType: 'uint256', type: 'uint256' },
      { name: 'cap', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'OverEpochCap',
  },
  {
    type: 'error',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'OwnableInvalidOwner',
  },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'OwnableUnauthorizedAccount',
  },
  { type: 'error', inputs: [], name: 'PnlOutOfRange' },
  { type: 'error', inputs: [], name: 'ReentrancyGuardReentrantCall' },
  { type: 'error', inputs: [], name: 'RoundIdTooLarge' },
  {
    type: 'error',
    inputs: [{ name: 'roundId', internalType: 'uint256', type: 'uint256' }],
    name: 'RoundIsLocked',
  },
  {
    type: 'error',
    inputs: [{ name: 'roundId', internalType: 'uint256', type: 'uint256' }],
    name: 'RoundNotLocked',
  },
  {
    type: 'error',
    inputs: [{ name: 'token', internalType: 'address', type: 'address' }],
    name: 'SafeERC20FailedOperation',
  },
  { type: 'error', inputs: [], name: 'SameHuman' },
  { type: 'error', inputs: [], name: 'TooManyAwards' },
  {
    type: 'error',
    inputs: [{ name: 'entryId', internalType: 'uint256', type: 'uint256' }],
    name: 'UnknownEntry',
  },
  {
    type: 'error',
    inputs: [{ name: 'humanId', internalType: 'bytes32', type: 'bytes32' }],
    name: 'UnknownHuman',
  },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
  { type: 'error', inputs: [], name: 'ZeroAmount' },
  { type: 'error', inputs: [], name: 'ZeroHumanId' },
] as const

/**
 *
 */
export const arenaAddress = {
  31337: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
} as const

/**
 *
 */
export const arenaConfig = { address: arenaAddress, abi: arenaAbi } as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MockUSDC
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 *
 */
export const mockUsdcAbi = [
  { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address', indexed: true },
      { name: 'spender', internalType: 'address', type: 'address', indexed: true },
      { name: 'value', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      { name: 'value', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Transfer',
  },
  {
    type: 'error',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'allowance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientAllowance',
  },
  {
    type: 'error',
    inputs: [
      { name: 'sender', internalType: 'address', type: 'address' },
      { name: 'balance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientBalance',
  },
  {
    type: 'error',
    inputs: [{ name: 'approver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidApprover',
  },
  {
    type: 'error',
    inputs: [{ name: 'receiver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidReceiver',
  },
  {
    type: 'error',
    inputs: [{ name: 'sender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSender',
  },
  {
    type: 'error',
    inputs: [{ name: 'spender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSpender',
  },
] as const

/**
 *
 */
export const mockUsdcAddress = {
  31337: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
} as const

/**
 *
 */
export const mockUsdcConfig = { address: mockUsdcAddress, abi: mockUsdcAbi } as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MockWETH
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 *
 */
export const mockWethAbi = [
  { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address', indexed: true },
      { name: 'spender', internalType: 'address', type: 'address', indexed: true },
      { name: 'value', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      { name: 'value', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'Transfer',
  },
  {
    type: 'error',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'allowance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientAllowance',
  },
  {
    type: 'error',
    inputs: [
      { name: 'sender', internalType: 'address', type: 'address' },
      { name: 'balance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientBalance',
  },
  {
    type: 'error',
    inputs: [{ name: 'approver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidApprover',
  },
  {
    type: 'error',
    inputs: [{ name: 'receiver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidReceiver',
  },
  {
    type: 'error',
    inputs: [{ name: 'sender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSender',
  },
  {
    type: 'error',
    inputs: [{ name: 'spender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSpender',
  },
] as const

/**
 *
 */
export const mockWethAddress = {
  31337: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
} as const

/**
 *
 */
export const mockWethConfig = { address: mockWethAddress, abi: mockWethAbi } as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TradeLog
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 *
 */
export const tradeLogAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'roundId', internalType: 'uint256', type: 'uint256' },
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'zeroGRequestIdHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'commit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'intentHash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'intents',
    outputs: [
      { name: 'agent', internalType: 'address', type: 'address' },
      { name: 'roundId', internalType: 'uint64', type: 'uint64' },
      { name: 'committedBlock', internalType: 'uint64', type: 'uint64' },
      { name: 'status', internalType: 'enum TradeLog.Status', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'fillTxHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'recordExecution',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'reason', internalType: 'uint8', type: 'uint8' },
    ],
    name: 'recordFailure',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'roundId', internalType: 'uint256', type: 'uint256', indexed: true },
      { name: 'agent', internalType: 'address', type: 'address', indexed: true },
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'zeroGRequestIdHash', internalType: 'bytes32', type: 'bytes32', indexed: false },
    ],
    name: 'IntentCommitted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'agent', internalType: 'address', type: 'address', indexed: true },
      { name: 'fillTxHash', internalType: 'bytes32', type: 'bytes32', indexed: false },
    ],
    name: 'IntentExecuted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'agent', internalType: 'address', type: 'address', indexed: true },
      { name: 'reason', internalType: 'uint8', type: 'uint8', indexed: false },
    ],
    name: 'IntentFailed',
  },
  {
    type: 'error',
    inputs: [{ name: 'intentHash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'AlreadyClosed',
  },
  {
    type: 'error',
    inputs: [{ name: 'intentHash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'AlreadyCommitted',
  },
  {
    type: 'error',
    inputs: [
      { name: 'intentHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'caller', internalType: 'address', type: 'address' },
    ],
    name: 'NotIntentAgent',
  },
  { type: 'error', inputs: [], name: 'RoundIdTooLarge' },
  {
    type: 'error',
    inputs: [{ name: 'intentHash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'UnknownIntent',
  },
  { type: 'error', inputs: [], name: 'ZeroHash' },
] as const

/**
 *
 */
export const tradeLogAddress = {
  31337: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
} as const

/**
 *
 */
export const tradeLogConfig = { address: tradeLogAddress, abi: tradeLogAbi } as const
