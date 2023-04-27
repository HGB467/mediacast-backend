import { createaWorker } from './worker.js'
import { createNewTransport } from './transport.js'
import {createServer} from 'http'
import { Server } from 'socket.io'
import {cpus} from 'os'



const server = createServer()

const io = new Server(server, {
    cors:{
      origin:'*'
    },
    
  });


io.on("connection",(socket)=>{

  socket.on('getPub',()=>{
    io.to(socket.id).emit('getPub',publisher)
  })

  socket.on('getRTPCapabilites',()=>{
      io.to(socket.id).emit('hereRTP',{capabilities:mediasoupRouters[0].rtpCapabilities})
  })

  socket.on('createTransport',({id,rtpCapabilities})=>{
    if(!rtpCapabilities) return;
    createTransport(socket,id)
  })

  socket.on('connectTransport',({dtlsParameters,id})=>{
    connectTransport(dtlsParameters,socket,id)
  })

  socket.on('produce',(data)=>{
    produce(data,socket)
  })


  socket.on("createConsumeTransport",(data)=>{
    createConsumeTransport(data,socket)
  })

  socket.on('transportConnect',(data)=>{
   connectConsumerTransport(data,socket)
  })

  socket.on('startConsuming',(data)=>{
    startConsuming(data,socket)
  })

  socket.on('closeProducer',async()=>{
   if(socket.id===publisher){
    publisher = null;
    await ProducerTransport?.close()
    io.to(socket.id).emit('closeProducer')
   }
  })

  socket.on('closeStream',async()=>{
    if(consumeTransport[socket.id]){
      await consumeTransport[socket.id].close();
      consumeTransport[socket.id] = null;
      const consumeridx = consumersIdx[socket.id]
      consumersinRouters[consumeridx] -=2;
      consumersIdx[socket.id] = null;
      io.to(socket.id).emit('closeStream',true)
      io.to(publisher).emit('consumerLeft')
     }
  })

  socket.on("disconnect",async()=>{
    if(socket.id===publisher){
      publisher = null;
      await ProducerTransport?.close()
     }
     if(consumeTransport[socket.id]){
      await consumeTransport[socket.id].close();
      consumeTransport[socket.id] = null;
      const consumeridx = consumersIdx[socket.id]
      consumersinRouters[consumeridx] -=2;
      consumersIdx[socket.id] = null;
      io.to(publisher).emit('consumerLeft')
     }
  })

})
  


let publisher;
let mediasoupRouters=[];
let consumersinRouters=[]
let consumerLimit = 600;
let ProducerTransport;
let consumeTransport=[];
let VideoProducer;
let AudioProducer;
let consumersIdx = []

const startMediasoup=async()=>{
    try{
        for(let i=0;i<cpus().length;i++){
          mediasoupRouters[i] = await createaWorker()
          consumersinRouters[i] = 0;
        }
    }
    catch(err){
        throw err;
    }
}

startMediasoup();



async function createTransport(socket,id){
    try{
        if(publisher) return;
        publisher = id;
        const {transport,params} = await createNewTransport(mediasoupRouters[0])
        ProducerTransport = transport;
        io.to(id).emit('transportCreated',{data:params})

    }
    catch(err){
        socket.emit('transportCreated',{data:'err'})
    }
}

async function connectTransport(params,socket,id){
    await ProducerTransport.connect({dtlsParameters:params})
    io.to(id).emit('transportConnected')
}

async function produce(data,socket){
    try{
        const {kind,rtpParameters,id} = data;
        if(kind==="video"){
          VideoProducer = await ProducerTransport.produce({kind,rtpParameters})
          for(let i=1;i<mediasoupRouters.length;i++){
            await mediasoupRouters[0]?.pipeToRouter({producerId:VideoProducer.id,router:mediasoupRouters[i]})
          }
          io.to(id).emit('producing',{producerId:VideoProducer.id,type:"video"})
          socket.broadcast.emit('newPub')
        }
        else if(kind==="audio"){
          AudioProducer = await ProducerTransport.produce({kind,rtpParameters})
          for(let i=1;i<mediasoupRouters.length;i++){
            await mediasoupRouters[0]?.pipeToRouter({producerId:AudioProducer.id,router:mediasoupRouters[i]})
          }
          io.to(id).emit('producing',{producerId:VideoProducer.id,type:"audio"})
        }
    }
    catch(err){
        console.log(err)
    }

}

async function createConsumeTransport(data,socket){
    try{
        const router = getRouter(socket);
        const {transport,params} = await createNewTransport(router)
        consumeTransport[socket.id] = transport;
    io.to(data.id).emit('ConsumeTransportCreated',{data:params})
      
    }
    catch(err){
        console.log(err)
        io.to(data.sockId).emit("ConsumeTransportCreated",{data:'err',id:data.id})
    }
}

function getRouter(socket){
  let routerToReturn;
  
  for(let i=0;i<mediasoupRouters.length;i++){
    if(consumersinRouters[i]<consumerLimit){
      routerToReturn = mediasoupRouters[i];
      consumersinRouters[i] +=2;
      consumersIdx[socket.id] = i
      break;
    }
  }

  if(!routerToReturn){
    let minIdx;
    consumersinRouters.forEach((consumerValue,idx)=>{
       if(idx===0){
        minIdx = idx;
       }
       else if(minIdx>consumerValue)
  {
    minIdx = idx;
  }  })
  routerToReturn = mediasoupRouters[minIdx];
  consumersinRouters[minIdx] +=2;
  consumersIdx[socket.id] = minIdx
  }

  return routerToReturn;
}

async function connectConsumerTransport(data,socket){
    const consumeTrans = consumeTransport[socket.id]
    await consumeTrans.connect({dtlsParameters:data.dtlsParameters})
    io.to(data.id).emit('consumerTransportConnected')
}

async function startConsuming(data,socket){
    try{
         let consumer = await consumeTransport[data.id].consume({
            producerId:VideoProducer.id,
            rtpCapabilities:data.rtpCapabilities,
        })
        io.to(data.id).emit('datarecv',{
          producerId:VideoProducer.id,
          kind:consumer.kind,
          id:consumer.id,
          type:consumer.type,
          rtpParameters:consumer.rtpParameters,
          producerPaused:consumer.producerPaused,
        })

        io.to(publisher).emit('newConsumer')

        consumer.on('producerclose',async()=>{
          io.to(data.id).emit('closeStream')
          await consumeTransport[data.id]?.close()
          consumeTransport[data.id] = null;
          const idx = consumersIdx[data.id]
          consumersinRouters[idx] -=2;
          consumersIdx[data.id] = null;
        })

        if(AudioProducer){
          let consumer = await consumeTransport[data.id].consume({
            producerId:AudioProducer.id,
            rtpCapabilities:data.rtpCapabilities,
        })
        io.to(data.id).emit('datarecv',{
          producerId:AudioProducer.id,
          kind:consumer.kind,
          id:consumer.id,
          type:consumer.type,
          rtpParameters:consumer.rtpParameters,
          producerPaused:consumer.producerPaused,
        })
        }
    }
    catch(err){
        console.log(err)
    }
}


server.listen(5000,()=>{
    console.log("App Listening Successfully!")
})



