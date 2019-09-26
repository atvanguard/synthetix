'use strict';

const fs = require('fs');
const path = require('path');

const Web3 = require('web3');

const { yellow, gray, red, green } = require('chalk');

const commander = require('commander');
const program = new commander.Command();

require('dotenv').config();

const snx = require('../index');

const { loadConnections, confirmAction } = require('../publish/src/util');

const logExchangeRates = (currencyKeys, rates) => {
	const results = [];
	for (let i = 0; i < rates.length; i++) {
		const rate = Web3.utils.fromWei(rates[i]);
		results.push({
			key: currencyKeys[i].name,
			price: rate,
		});
	}
	for (const rate of results) {
		console.log(green(`currencyKey: ${rate.key}, price: ${rate.price}`));
	}
};

program
	.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'kovan')
	.action(async ({ network }) => {
		console.log(`Running tests on ${network}`);

		const sources = snx.getSource({ network });
		const targets = snx.getTarget({ network });

		const synths = snx.getSynths({ network });

		const cryptoSynths = synths
			.filter(({ asset }) => asset !== 'USD')
			.filter(
				({ category }) => category === 'crypto' || category === 'internal' || category === 'index'
			);

		const forexSynths = synths
			.filter(({ asset }) => asset !== 'USD')
			.filter(({ category }) => category === 'forex' || category === 'commodity');

		const { providerUrl, privateKey, etherscanLinkPrefix } = loadConnections({ network });
		const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));
		try {
			const gas = 4e6; // 4M
			const gasPrice = web3.utils.toWei('5', 'gwei');
			const [sUSD, sETH] = ['sUSD', 'sETH'].map(web3.utils.asciiToHex);

			const owner = web3.eth.accounts.wallet.add(privateKey);

			// We are using the testnet deployer account, so presume they have some testnet ETH
			const user1 = web3.eth.accounts.create();
			web3.eth.accounts.wallet.add(user1);
			console.log(gray(`Created test account ${user1.address}`));
			console.log(gray(`Owner account ${owner.address}`));

			// store keys in local file in case error and need to recover account
			fs.appendFileSync(
				path.join(__dirname, 'test_keys.txt'),
				`${new Date().toString()}\t\t${network}\t\t${user1.address}\t\t${user1.privateKey}\n`
			);
			console.log(`Test privkeys: ${user1.privateKey}`);

			/**  VIEWS OF SYNTHETIX STATUS **/

			const exchangeRates = new web3.eth.Contract(
				sources['ExchangeRates'].abi,
				targets['ExchangeRates'].address
			);
			const currencyKeys = [{ name: 'SNX' }].concat(cryptoSynths).concat(forexSynths);
			const currencyKeysBytes = currencyKeys.map(key => web3.utils.asciiToHex(key.name));

			const ratesAreStale = await exchangeRates.methods.anyRateIsStale(currencyKeysBytes).call();

			console.log(green(`RatesAreStale - ${ratesAreStale}`));
			if (ratesAreStale) {
				throw Error('Rates are stale');
			}

			// View all current ExchangeRates
			const rates = await exchangeRates.methods.ratesForCurrencies(currencyKeysBytes).call();

			logExchangeRates(currencyKeys, rates);

			// Synthetix contract
			const Synthetix = new web3.eth.Contract(
				sources['Synthetix'].abi,
				targets['ProxySynthetix'].address
			);

			const SynthetixState = new web3.eth.Contract(
				sources['SynthetixState'].abi,
				targets['SynthetixState'].address
			);

			// Check totalIssuedSynths and debtLedger matches
			const totalIssuedSynths = await Synthetix.methods.totalIssuedSynths(sUSD).call();
			const debtLedgerLength = await SynthetixState.methods.debtLedgerLength().call();

			console.log(
				green(
					`TotalIssuedSynths in sUSD: ${web3.utils.fromWei(
						totalIssuedSynths
					)} - debtLedgerLenght: ${debtLedgerLength}`
				)
			);

			if (debtLedgerLength > 0 && totalIssuedSynths === 0) {
				throw Error('DebtLedger has debt but totalIssuedSynths is 0');
			}

			try {
				await confirmAction(yellow(`Do you want to continue? (y/n) `));
			} catch (err) {
				console.log(gray(`Operation terminated`));
				return;
			}

			// #1 - Send the account some test ether
			console.log(gray(`Transferring 0.1 test ETH to ${user1.address}`));
			const { transactionHash: txn0Hash } = await web3.eth.sendTransaction({
				from: owner.address,
				to: user1.address,
				value: web3.utils.toWei('0.1'), // 0.1 test ETH
				gas,
				gasPrice,
			});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn0Hash}`));

			console.log(gray(`Transferring 2000 SNX to user1 (${user1.address})`));
			const { transactionHash: txn1Hash } = await Synthetix.methods
				.transfer(user1.address, web3.utils.toWei('2000'))
				.send({
					from: owner.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn1Hash}`));

			// #2 - Mint some sUSD from test account
			console.log(gray(`Issuing 100 sUSD from (${user1.address}`));
			const amountToIssue = web3.utils.toWei('100');
			const { transactionHash: txn2Hash } = await Synthetix.methods
				.issueSynths(sUSD, amountToIssue)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn2Hash}`));

			// #3 - Deposit 60 sUSD to Depot
			const Depot = new web3.eth.Contract(sources['Depot'].abi, targets['Depot'].address);
			const SynthsUSD = new web3.eth.Contract(sources['Synth'].abi, targets['ProxysUSD'].address);

			// get balance
			const balance = await SynthsUSD.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has sUSD balanceOf - ${web3.utils.fromWei(balance)}`));

			// deposit to Depot
			console.log(gray(`Deposit 60 sUSD to depot from (${user1.address})`));
			const amountToDeposit = web3.utils.toWei('60');
			const { transactionHash: txn3Hash } = await SynthsUSD.methods
				.transfer(Depot.options.address, amountToDeposit)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn3Hash}`));

			// #4 withdraw deposited synths from Depot
			console.log(gray(`Withdraw 60 sUSD from Depot for (${user1.address})`));
			const { transactionHash: txn4Hash } = await Depot.methods.withdrawMyDepositedSynths().send({
				from: user1.address,
				gas,
				gasPrice,
			});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn4Hash}`));

			// check balance
			const balanceAfter = await SynthsUSD.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has sUSD balanceOf - ${web3.utils.fromWei(balanceAfter)}`));

			// #5 Exchange sUSD to sETH
			console.log(gray(`Exchange sUSD --> sETH for user - (${user1.address})`));
			const amountToExchange = web3.utils.toWei('100');
			const { transactionHash: txn5Hash } = await Synthetix.methods
				.exchange(sUSD, amountToExchange, sETH, user1.address)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn5Hash}`));

			// check sETH balance after exchange
			const SynthsETH = new web3.eth.Contract(sources['Synth'].abi, targets['ProxysETH'].address);
			const sETHBalance = await SynthsETH.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has sETH balanceOf - ${web3.utils.fromWei(sETHBalance)}`));

			// #6 Exchange balance of sETH back to sUSD
			console.log(gray(`Exchange sETH --> sUSD for user - (${user1.address})`));
			const { transactionHash: txn6Hash } = await Synthetix.methods
				.exchange(sETH, sETHBalance, sUSD, user1.address)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn6Hash}`));

			// #7 Burn all remaining sUSD to unlock SNX
			const remainingSynthsUSD = await SynthsUSD.methods.balanceOf(user1.address).call();
			console.log(gray(`Burn all remaining synths for user - (${user1.address})`));
			const { transactionHash: txn7Hash } = await Synthetix.methods
				.burnSynths(sUSD, remainingSynthsUSD)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn7Hash}`));

			// check transferable SNX after burning
			const transferableSNX = await Synthetix.methods.transferableSynthetix(user1.address).call();
			console.log(
				gray(
					`Transferable SNX of ${web3.utils.fromWei(transferableSNX)} for user (${user1.address}`
				)
			);

			// #8 Transfer SNX back to owner
			console.log(gray(`Transferring SNX back to owner (${user1.address}`));
			const { transactionHash: txn8Hash } = await Synthetix.methods
				.transfer(user1.address, transferableSNX)
				.send({
					from: user1.address,
					gas,
					gasPrice,
				});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn8Hash}`));

			// if fees available claim, check feePeriod closable, close if it can be closed and claim fees.

			// finally, send back all test ETH to the owner
			const testEthBalanceRemaining = await web3.eth.getBalance(user1.address);
			const gasLimitForTransfer = 21000;
			const testETHBalanceMinusTxnCost = (
				testEthBalanceRemaining -
				gasLimitForTransfer * gasPrice
			).toString();

			console.log(
				gray(
					`Transferring remaining test ETH back to owner (${web3.utils.fromWei(
						testETHBalanceMinusTxnCost
					)})`
				)
			);
			const { transactionHash: txn9Hash } = await web3.eth.sendTransaction({
				from: user1.address,
				to: owner.address,
				value: testETHBalanceMinusTxnCost,
				gas: gasLimitForTransfer,
				gasPrice,
			});
			console.log(yellow(`Success. ${etherscanLinkPrefix}/tx/${txn9Hash}`));

			console.log();
			console.log(gray(`Integration test on ${network.toUpperCase()} completed successfully.`));
		} catch (err) {
			if (/Transaction has been reverted/.test(err)) {
				const txnHash = err.message.match(/(?:"transactionHash":\s")(\w+)(")/)[1];
				console.error(red(`Failure: EVM reverted ${etherscanLinkPrefix}/tx/${txnHash}`));
			} else {
				console.error(err);
			}
			process.exitCode = 1;
		}
	});

// perform as CLI tool if not run as module
if (require.main === module) {
	require('pretty-error').start();

	program.parse(process.argv);
}
