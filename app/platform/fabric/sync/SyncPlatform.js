/*
 * SPDX-License-Identifier: Apache-2.0
 */

const path = require('path');
const fs = require('fs-extra');

const SyncService = require('../sync/SyncService');
const FabricUtils = require('../utils/FabricUtils');
const FabricEvent = require('./FabricEvent');

const helper = require('../../../common/helper');

const logger = helper.getLogger('SyncPlatform');
const ExplorerError = require('../../../common/ExplorerError');

const CRUDService = require('../../../persistence/fabric/CRUDService');
const MetricService = require('../../../persistence/fabric/MetricService');

const fabric_const = require('../utils/FabricConst').fabric.const;
const explorer_mess = require('../../../common/ExplorerMessage').explorer;

const config_path = path.resolve(__dirname, '../config.json');

/**
 *
 *
 * @class SyncPlatform
 */
class SyncPlatform {
	/**
	 * Creates an instance of SyncPlatform.
	 * @param {*} persistence
	 * @param {*} sender
	 * @memberof SyncPlatform
	 */
	constructor(persistence, sender) {
		this.network_name = null;
		this.client_name = null;
		this.client = null;
		this.eventHub = null;
		this.sender = sender;
		this.persistence = persistence;
		this.syncService = new SyncService(this, this.persistence);
		this.blocksSyncTime = 60000;
		this.client_configs = null;
	}

	/**
	 *
	 *
	 * @param {*} args
	 * @returns
	 * @memberof SyncPlatform
	 */
	async initialize(args) {
		logger.debug(
			'******* Initialization started for child client process %s ******',
			this.client_name
		);

		// Loading the config.json
		const all_config = JSON.parse(fs.readFileSync(config_path, 'utf8'));
		const network_configs = all_config[fabric_const.NETWORK_CONFIGS];

		if (args.length === 0) {
			// Get the first network and first client
			this.network_name = Object.keys(network_configs)[0];
			this.client_name = network_configs[this.network_name].name;
		} else if (args.length === 1) {
			// Get the first client with respect to the passed network name
			this.network_name = args[0];
			this.client_name = Object.keys(
				network_configs[this.network_name].clients
			)[0];
		} else {
			this.network_name = args[0];
			this.client_name = args[1];
		}

		console.log(
			`\n${explorer_mess.message.MESSAGE_1002}`,
			this.network_name,
			this.client_name
		);

		// Setting the block synch interval time
		await this.setBlocksSyncTime(all_config);

		logger.debug('Blocks synch interval time >> %s', this.blocksSyncTime);
		// Update the discovery-cache-life as block synch interval time in global config
		global.hfc.config.set('discovery-cache-life', this.blocksSyncTime);
		global.hfc.config.set('initialize-with-discovery', true);

		const client_configs = network_configs[this.network_name];

		this.client_configs = await FabricUtils.setOrgEnrolmentPath(client_configs);

		this.client = await FabricUtils.createFabricClient(
			this.client_configs,
			this.client_name
		);
		if (!this.client) {
			throw new ExplorerError(explorer_mess.error.ERROR_2011);
		}

		// Updating the client network and other details to DB
		const res = await this.syncService.synchNetworkConfigToDB(this.client);
		if (!res) {
			return;
		}

		// Start event
		this.eventHub = new FabricEvent(this.client, this.syncService);
		await this.eventHub.initialize();

		const sync = () => {
			console.log(
				`******************Synchronization at ${new Date()}******************`
			);
			this.eventHub.synchBlocks();
			setTimeout(() => {
				sync();
			}, this.blocksSyncTime);
		};

		setTimeout(sync, this.blocksSyncTime);
		console.log(
			'******* Initialization end for child client process %s ******',
			this.client_name
		);
	}

	/**
	 *
	 *
	 * @memberof SyncPlatform
	 */
	async isChannelEventHubConnected() {
		for (const [channel_name, channel] of this.client.getChannels().entries()) {
			// Validate channel event is connected
			const status = this.eventHub.isChannelEventHubConnected(channel_name);
			if (status) {
				await this.syncService.synchBlocks(this.client, channel);
			} else {
				// Channel client is not connected then it will reconnect
				this.eventHub.connectChannelEventHub(channel_name);
			}
		}
	}

	setBlocksSyncTime(blocksSyncTime) {
		if (blocksSyncTime) {
			const time = parseInt(blocksSyncTime, 10);
			if (!isNaN(time)) {
				this.blocksSyncTime = time * 60 * 1000;
			}
		}
	}

	/**
	 *
	 *
	 * @memberof SyncPlatform
	 */
	setPersistenceService() {
		// Setting platform specific CRUDService and MetricService
		this.persistence.setMetricService(
			new MetricService(this.persistence.getPGService())
		);
		this.persistence.setCrudService(
			new CRUDService(this.persistence.getPGService())
		);
	}

	/**
	 *
	 *
	 * @param {*} notify
	 * @memberof SyncPlatform
	 */
	send(notify) {
		if (this.sender) {
			this.sender.send(notify);
		}
	}

	/**
	 *
	 *
	 * @memberof SyncPlatform
	 */
	destroy() {
		if (this.eventHub) {
			this.eventHub.disconnectEventHubs();
		}
	}
}

module.exports = SyncPlatform;
