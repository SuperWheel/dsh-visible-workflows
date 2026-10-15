/** Loopback-only, synthetic endpoint used by the official Harness Web acceptance. */
import { createServer } from 'node:http'
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://127.0.0.1:5191')
 if(request.method!=='GET'||url.pathname!=='/greeting'){response.writeHead(404,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'not_found'}));return}
 const name=(url.searchParams.get('name')||'Harness').slice(0,100)
 response.writeHead(200,{'Content-Type':'application/json; charset=utf-8'})
 response.end(JSON.stringify({message:`Hello, ${name}`,source:'local acceptance fixture'}))
})
server.listen(5191,'127.0.0.1',()=>console.log('Synthetic HTTP acceptance endpoint listening on loopback port 5191'))
process.on('SIGINT',()=>server.close())
process.on('SIGTERM',()=>server.close())
