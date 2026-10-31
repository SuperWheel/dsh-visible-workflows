import VisibleWorkflowService from '../../src/host/index.ts'
const mode=(config:Record<string,unknown>)=>(VisibleWorkflowService as any).Config(config).planningCompiler
console.log(JSON.stringify({defaultMode:mode({stateDirectory:'x'}),rollbackMode:mode({stateDirectory:'x',planningCompiler:'compact-repair'})}))
