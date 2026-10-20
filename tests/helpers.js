import http from 'node:http';
export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
export async function json(url, {body, headers = {}, method = body === undefined ? 'GET' : 'POST', agent = false} = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method, agent, headers: {...(payload ? {'content-type':'application/json', 'content-length': Buffer.byteLength(payload)} : {}), ...headers}}, res => {
      let data = '';
      res.on('data', chunk => {data += chunk;});
      res.on('end', () => { try {resolve({code:res.statusCode, body:JSON.parse(data)});} catch (e) {reject(e);} });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}
