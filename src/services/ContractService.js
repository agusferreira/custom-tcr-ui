import Web3 from 'web3';
import _ from 'lodash';
import { Registry } from 'ethereum-tcr-api';
import PromisesQueueWatcher from '../utils/PromisesQueueWatcher';
const httpProvider = new Web3(new Web3.providers.HttpProvider('https://rinkeby.infura.io/Dy4nhcddBU78aJPZ7TDA'));
const SYNC_INTERVAL = 10000;
let currentContract = '';
let registryNotificationCandidate = null;
let rewardNotificationCandidate = null;
let parametrizerNotificationCandidate = null;
let onNewBlockHandler = null;

// TODO: in future store only one registry
const _map = new Map();

const queueWatcher = new PromisesQueueWatcher();

const handleEventsChain = async (events, handler) => {
  for (let event of events) {
    await handler(event);
  }
};

class ContractSynchronizer {
  constructor (contract, handlersMap, parallelizeEventsMethod) {
    this.contract = contract;
    this._handlersMap = handlersMap;
    this._parallelizeEvents = parallelizeEventsMethod;
  }

  async handlePastEvents (lastKnownBlock, actualBlock) {
    if (actualBlock <= lastKnownBlock) {
      return;
    }

    // events duplicates. We exclude first block.
    try {
      let events = await this.contract.getPastEvents(
        'allEvents',
        {fromBlock: lastKnownBlock + 1, toBlock: actualBlock}
      );
      await Promise.all(
        this._parallelizeEvents(events)
          .map(arr => handleEventsChain(arr, (e) => this._handleEvent(e)))
      );
    } catch (error) {
      console.error(error);
    }
  }

  async _handleEvent (event) {
    if (this._handlersMap.has(event.event)) {
      await this._handlersMap.get(event.event)(event);
    }
  }
}

// TODO: refactor this class
class SyncManager {
  constructor (registry, accountAddress) {
    this.registry = registry;
    this.accountAddress = accountAddress;
    this.regisrtySynchronizer = this._createRegistrySynchronizer();
    this.votingSynchronizer = null;
    this.paramsSynchronizer = null;
    this.lastKnownBlock = 0;
    this._timeout = 0;
    this._synchronizationRunning = false;
    this._watcher = null;
    this._rewardWatcher = null;
    this._parametrizerWatcher = null;
    this._listingsMap = new Map();
    this._unclaimedPools = new Map();
    this._poolIdToListing = new Map();
    this._paramsProposalsMap = new Map();
  }

  _createRegistrySynchronizer () {
    let map = new Map();
    map.set('_Application', (e) => this._onApplication(e));
    map.set('_ApplicationRemoved', (e) => this._onRemove(e));
    map.set('_ListingRemoved', (e) => this._onRemove(e));
    map.set('_NewDomainWhitelisted', (e) => this._onNewDomainWhitelisted(e));
    map.set('_Challenge', (e) => this._onChallenge(e));
    map.set('_ChallengeFailed', (e) => this._onChallengeResolved(e, false));
    map.set('_ChallengeSucceeded', (e) => this._onChallengeResolved(e, true));
    map.set('_RewardClaimed', (e) => this._onRewardClaimed(e));
    return new ContractSynchronizer(
      this.registry.contract,
      map,
      (events) => {
        let parts = _.partition(events, (e) => {
          return e.event === '_Application' || e.event === '_ApplicationRemoved' ||
            e.event === '_ListingRemoved' || e.event === '_NewDomainWhitelisted';
        });
        let grouped = _.groupBy(parts[0], 'returnValues.domain');
        parts[1].forEach(e => {
          if (e.event === '_Challenge') {
            e.returnValues.challengeID = e.returnValues.pollID;
          }
        });
        let groupedChallenge = _.groupBy(parts[1], 'returnValues.challengeID');
        return _.keys(grouped).map(k => grouped[k])
          .concat(_.keys(groupedChallenge).map(k => groupedChallenge[k]));
      }
    );
  }

  async _createVotingSynchronizer () {
    let plcr = await this.registry.getPLCRVoting();
    let map = new Map();
    map.set('VoteCommitted', (e) => this._onVoteCommitted(e));
    map.set('VoteRevealed', (e) => this._onVoteRevealed(e));
    return new ContractSynchronizer(
      plcr.contract,
      map,
      (events) => {
        let filtered = _.filter(events, (e) => e.returnValues.voter === this.accountAddress);
        let grouped = _.groupBy(filtered, 'returnValues.pollID');
        return _.keys(grouped).map(k => grouped[k]);
      }
    );
  }

  async _createParamsSynchronizer () {
    let parametrizer = await this.registry.getParameterizer();
    let map = new Map();
    map.set('_ReparameterizationProposal', (e) => this._onReparameterizationProposal(e));
    map.set('_NewChallenge', (e) => this._onReparameterizationChallenge(e));
    return new ContractSynchronizer(
      parametrizer.contract,
      map,
      (events) => {
        let grouped = _.groupBy(events, 'returnValues.propID');
        return _.keys(grouped).map(k => grouped[k]);
      }
    );
  }

  // TODO: сделать более универсально
  setRewardWatcher (watcher) {
    this._rewardWatcher = watcher;
  }

  setRegistryWatcher (watcher) {
    this._watcher = watcher;
  }

  setParametrizerWatcher (watcher) {
    this._parametrizerWatcher = watcher;
  }

  _callWatcher () {
    if (typeof this._watcher === 'function') {
      this._watcher(...arguments);
    }
  }

  addListing (listing, data, account) {
    this._listingsMap.set(listing, {listing: listing, data, account});
    this._callWatcher('add', listing);
  }

  removeListing (listing) {
    this._listingsMap.delete(listing);
    this._callWatcher('remove', listing);
  }

  async synchronize () {
    if (this._synchronizationRunning) {
      return;
    }
    this._synchronizationRunning = true;
    if (!this.votingSynchronizer) {
      this.votingSynchronizer = await this._createVotingSynchronizer();
    }
    if (!this.paramsSynchronizer) {
      this.paramsSynchronizer = await this._createParamsSynchronizer();
    }
    await this._synchronizeAndUpdateActualBlock();
  }

  async _synchronizeAndUpdateActualBlock () {
    clearInterval(this._timeout);
    let actualBlock = await getActualBlock();
    // TODO: сейчас последовательность важна. Подумать как унифицировать.
    await this.votingSynchronizer.handlePastEvents(this.lastKnownBlock, actualBlock.number);
    await this.regisrtySynchronizer.handlePastEvents(this.lastKnownBlock, actualBlock.number);
    await this.paramsSynchronizer.handlePastEvents(this.lastKnownBlock, actualBlock.number);
    this.lastKnownBlock = actualBlock.number;
    // TODO: вынести в более подходящее место
    if (typeof onNewBlockHandler === 'function') {
      onNewBlockHandler(actualBlock);
    }
    this._timeout = setTimeout(() => this._synchronizeAndUpdateActualBlock(), SYNC_INTERVAL);
  }

  clear () {
    this._listingsMap.clear();
    this._unclaimedPools.clear();
    this._poolIdToListing.clear();
    this._paramsProposalsMap.clear();
    this.lastKnownBlock = 0;
    clearTimeout(this._timeout);
    this._synchronizationRunning = false;
    this._watcher = null;
  }

  async _onApplication (event) {
    const hash = event.returnValues.listingHash;
    const data = event.returnValues.data;
    const listing = this.registry.getListing(hash);
    const exists = await listing.exists();
    if (exists) {
      const listingOwner = await listing.getOwner();
      this.addListing(hash, data, listingOwner);
    }
  }

  _onRemove (event) {
    this.removeListing(event.returnValues.listingHash);
  }

  _onNewDomainWhitelisted (event) {
    this._callWatcher('change', event.returnValues.domain);
  }

  _onChallenge (event) {
    this._poolIdToListing.set(event.returnValues.pollID, {
      challengeId: event.returnValues.pollID,
      listing: event.returnValues.listingHash
    });
    this._callWatcher('change', event.returnValues.listingHash);
  }

  _onChallengeResolved (event, isSucceeded) {
    let challengeId = event.returnValues.challengeID;
    // if listing status updated we need to refresh it on client
    if (!isSucceeded && this._poolIdToListing.has(challengeId)) {
      let changed = this._poolIdToListing.get(challengeId);
      this._callWatcher('change', changed.listing);
    }
    if (this._unclaimedPools.has(challengeId)) {
      let pool = this._unclaimedPools.get(challengeId);
      if (pool.choice === isSucceeded) {
        this._unclaimedPools.delete(challengeId);
        this._poolIdToListing.delete(challengeId);
      } else {
        pool.isResolved = true;
      }
    } else {
      this._poolIdToListing.delete(challengeId);
    }
  }

  _onRewardClaimed (event) {
    if (event.returnValues.voter === this.accountAddress) {
      this._unclaimedPools.delete(event.returnValues.challengeID);
      this._poolIdToListing.delete(event.returnValues.challengeID);
      if (typeof this._rewardWatcher === 'function') {
        this._rewardWatcher('claimed');
      }
    }
  }

  _onVoteCommitted (event) {}

  _onVoteRevealed (event) {
    this._unclaimedPools.set(event.returnValues.pollID, {
      challengeId: event.returnValues.pollID,
      numTokens: event.returnValues.numTokens,
      isResolved: false,
      choice: event.returnValues.choice === '1'
    });
  }

  _onReparameterizationProposal (event) {
    this._paramsProposalsMap.set(event.returnValues.name, event.returnValues.value);
    if (typeof this._parametrizerWatcher === 'function') {
      this._parametrizerWatcher('change', event.returnValues.name);
    }
  }

  _onReparameterizationChallenge (event) {}

  listings () {
    return [...this._listingsMap.values()];
  }

  listingsToClaimReward () {
    return [...this._unclaimedPools.keys()]
      .map((id) => {
        let poolData = _.assign(this._unclaimedPools.get(id), this._poolIdToListing.get(id));
        return poolData;
      }).filter((item) => item.isResolved);
  }

  parametrizerProposals () {
    const proposals = {};
    const iterator = this._paramsProposalsMap.keys();
    for (let key of iterator) {
      proposals[key] = this._paramsProposalsMap.get(key);
    }
    return proposals;
  }

  synchronizationRunning () {
    return this._synchronizationRunning;
  }
}

const getActualBlock = async () => {
  try {
    let block = await httpProvider.eth.getBlock('latest');
    return block;
  } catch (err) {
    console.error(err);
  }
  return 0;
};

const prepareSynchronizers = async (address, accountAddress) => {
  if (!_map.has(address)) {
    _map.set(address, new SyncManager(new Registry(address, httpProvider), accountAddress));
  }
  if (address !== currentContract && currentContract) {
    _map.get(currentContract).clear();
  }
  currentContract = address;
  let synchronizationRunning = _map.get(address).synchronizationRunning();
  console.time('sync');
  await _map.get(address).synchronize();
  console.timeEnd('sync');
  // TODO: hack
  if (typeof registryNotificationCandidate === 'function' && !synchronizationRunning) {
    _map.get(currentContract).setRegistryWatcher(registryNotificationCandidate);
    registryNotificationCandidate = null;
  }
  if (typeof rewardNotificationCandidate === 'function' && !synchronizationRunning) {
    _map.get(currentContract).setRewardWatcher(rewardNotificationCandidate);
    rewardNotificationCandidate = null;
  }
  if (typeof parametrizerNotificationCandidate === 'function' && !synchronizationRunning) {
    _map.get(currentContract).setParametrizerWatcher(parametrizerNotificationCandidate);
    parametrizerNotificationCandidate = null;
  }
};

// TODO: Добавить отмену, т.к. сейчас дожидаемся пока отработает прошлый запрос.
const getPromiseFromQueue = (address, accountAddress) => {
  return new Promise((resolve, reject) => {
    queueWatcher.add(async () => {
      try {
        await prepareSynchronizers(address, accountAddress);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
};

const getListings = async (address, accountAddress) => {
  await getPromiseFromQueue(address, accountAddress);
  return _map.get(address).listings();
};

const getListing = async (address, hash, accountAddress) => {
  return _map.get(address).listings().find(item => item.listing === hash);
};

const getListingsToClaimReward = async (address, accountAddress) => {
  await getPromiseFromQueue(address, accountAddress);
  return _map.get(address).listingsToClaimReward();
};

const getParameterizerProposals = async (address, accountAddress) => {
  await getPromiseFromQueue(address, accountAddress);
  return _map.get(address).parametrizerProposals();
};

// TODO: кривоватая схема
const setRegistryNotificationHandler = (handler) => {
  registryNotificationCandidate = handler;
};
const setRewardNotificationHandler = (handler) => {
  rewardNotificationCandidate = handler;
};
const setParametrizerNotificationHandelr = (handler) => {
  parametrizerNotificationCandidate = handler;
};

const onNewBlock = (handler) => {
  onNewBlockHandler = handler;
};

export default {
  getListings,
  getListing,
  getListingsToClaimReward,
  getParameterizerProposals,
  setRegistryNotificationHandler,
  setRewardNotificationHandler,
  setParametrizerNotificationHandelr,
  onNewBlock
};
