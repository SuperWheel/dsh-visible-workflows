/** Synchronous SHA-256 for portable definition metadata (also used by browser import). */
const primes:number[]=[]
for(let n=2;primes.length<64;n++)if(!primes.some(p=>p*p<=n&&n%p===0))primes.push(n)
const fraction=(value:number)=>(value-Math.floor(value))*0x100000000>>>0
const initial=primes.slice(0,8).map(p=>fraction(Math.sqrt(p)))
const constants=primes.map(p=>fraction(Math.cbrt(p)))
const rotate=(x:number,n:number)=>(x>>>n)|(x<<(32-n))
export function jsonDigest(value:unknown):string {
  const source=new TextEncoder().encode(JSON.stringify(value)),length=Math.ceil((source.length+9)/64)*64
  const bytes=new Uint8Array(length);bytes.set(source);bytes[source.length]=128
  const data=new DataView(bytes.buffer);data.setUint32(length-8,Math.floor(source.length/0x20000000));data.setUint32(length-4,(source.length*8)>>>0)
  const hash=[...initial],w=new Uint32Array(64)
  for(let offset=0;offset<length;offset+=64){
    for(let i=0;i<16;i++)w[i]=data.getUint32(offset+i*4)
    for(let i=16;i<64;i++){
      const x=w[i-15]!,y=w[i-2]!,s0=rotate(x,7)^rotate(x,18)^(x>>>3),s1=rotate(y,17)^rotate(y,19)^(y>>>10)
      w[i]=(w[i-16]!+s0+w[i-7]!+s1)>>>0
    }
    let [a,b,c,d,e,f,g,h]=hash as [number,number,number,number,number,number,number,number]
    for(let i=0;i<64;i++){
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]!+w[i]!)>>>0
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0
    }
    for(const[i,x]of [a,b,c,d,e,f,g,h].entries())hash[i]=(hash[i]!+x)>>>0
  }
  return hash.map(x=>x.toString(16).padStart(8,'0')).join('')
}
