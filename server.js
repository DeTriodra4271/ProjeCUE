const http = require('http');
const { Server } = require('socket.io');
const { attach } = require('./roomServer');

const server = http.createServer();
attach(new Server(server, { cors: { origin: '*' } }));
server.listen(3000, () => console.log('Sunucu Port 3000 üzerinde aktif'));
