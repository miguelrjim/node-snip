const sni = require('sni-reader');
const net = require('net');
const dns = require('dns');
const log4js = require('log4js');
const dnsLog = log4js.getLogger('dns');
const tcpLog = log4js.getLogger('tcp');
const sniLog = log4js.getLogger('sni');
const AsyncCache = require('async-cache');

const port = process.env.PORT || 443;
if (process.env.DNS) {
	dns.setServers(process.env.DNS.split(','));
}
const shutdownGrace = process.env.SHUTDOWN_GRACE || 5000;
dnsLog.level = process.env.LOG_LEVEL || 'INFO';
tcpLog.level = process.env.LOG_LEVEL || 'INFO';
sniLog.level = process.env.LOG_LEVEL || 'INFO';

const dnsCache = new AsyncCache({
	max: 1000,
	maxAge: process.env.DNS_CACHE || 3600 * 1000,
	load: function (key, cb) {
		dnsLog.debug('Looking up A', key);
		dns.resolve4(key, cb);
	}
});

function initSession(serverSocket, sniName) {
	dnsCache.get(sniName, function (err, addresses) {
		if (err) {
			serverSocket.end();
			dnsLog.warn(serverSocket.remoteAddress, sniName, 'resolve', err ? err.code : null);
			return;
		}
		const ip = addresses[0];
		const clientSocket = net.connect({ port: 443, type: 'tcp', host: ip });
		tcpLog.debug(serverSocket.remoteAddress, sniName, 'connecting', addresses);

		clientSocket.on('connect', function () {
			serverSocket.pipe(clientSocket).pipe(serverSocket);
			tcpLog.info(serverSocket.remoteAddress, sniName, 'connected', ip);
		});
		clientSocket.on('error', function (err) {
			tcpLog.error(sniName, 'Client socket reported', err.code);
			serverSocket.end();
		})
		serverSocket.on('error', function (err) {
			tcpLog.error(serverSocket.remoteAddress, 'Server socket reported', err.code);
			clientSocket.end();
		})
	});
};

function interrupt() {
	server.close();
	server.getConnections(function (err, count) {
		if (!err && count) {
			console.error('Waiting for clients to disconnect. Grace', shutdownGrace);
			setTimeout(function () {
				process.exit();
			}, shutdownGrace);
		} else if (err) {
			console.fatal('Error while receiving interrupt! Attempt to bail, no grace.', err);
			process.exit();
		}
	});
};

const server = net.createServer(function (serverSocket) {
	sni(serverSocket, function (err, sniName) {
		if (err) {
			sniLog.trace(err);
			serverSocket.end();
		} else if (sniName) {
			sniLog.debug(serverSocket.remoteAddress, sniName);
			serverSocket.on('error', function (err) {
				if (err.code == 'EPIPE') {
					sniLog.debug(serverSocket.remoteAddress, 'Client disconnected before the pipe was connected.');
				} else {
					sniLog.fatal(err);
				}
				serverSocket.end();
			});
			initSession(serverSocket, sniName);
		} else {
			sniLog.warn(serverSocket.remoteAddress, '(none)');
			serverSocket.end();
		}
	});
}).listen(port, '0.0.0.0');
tcpLog.info('Started listening on tcp4 port', port);

process.once('SIGINT', interrupt);