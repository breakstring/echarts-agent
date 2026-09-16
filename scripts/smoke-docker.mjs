import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import { extendedSamples } from '../examples/extended/samples.mjs';
const image=process.argv[2]??'echarts-agent:local-arm64';const live=process.argv.includes('--live');const a2a=process.argv.includes('--a2a');
const docker=(args,input)=>execFileSync('docker',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:180000});
const name=`echarts-agent-smoke-${Date.now()}`;const tmp=mkdtempSync(join(tmpdir(),'echarts-agent-smoke-'));let started=false;
try{
 const args=['run','-d','--name',name,'--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--memory','768m','--cpus','2','--pids-limit','128','-e','SERVICE_API_KEY=container-smoke-only'];
 if(live){const source=parseEnv(readFileSync('.env.local','utf8'));const allowed=['LLM_PROVIDER','LLM_MODEL','LLM_API_KEY','LLM_BASE_URL','llm_provider','llm_default_model','llm_api_key','llm_base_url'];const lines=allowed.filter(k=>source[k]).map(k=>{assert.ok(!/[\r\n]/.test(source[k]));return `${k}=${source[k]}`;});writeFileSync(join(tmp,'provider.env'),lines.join('\n'),{mode:0o600});args.push('--env-file',join(tmp,'provider.env'),'-e','SMOKE_LIVE=true');}
 else args.push('--network','none','-e','LLM_ENABLED=false');
 if(a2a)args.push('-e','A2A_ENABLED=true','-e','A2A_PUBLIC_URL=http://127.0.0.1:3000');
 args.push(image);docker(args);started=true;
 const out=docker(['exec','-i',name,'node','--input-type=module'],`const extendedSamples=${JSON.stringify(extendedSamples)};\n`+readFileSync('scripts/container-check.mjs','utf8'));
 const stats=JSON.parse(docker(['stats','--no-stream','--format','{{json .}}',name]));
 const began=performance.now();docker(['stop','--time','10',name]);const state=JSON.parse(docker(['inspect','--format','{{json .State}}',name]));assert.equal(state.ExitCode,0);assert.equal(state.OOMKilled,false);
 const imageId=docker(['image','inspect','--format','{{.Id}}',image]).trim();
 const result={image,imageId,a2a,network:live?'bridge':'none',limits:{cpus:2,memoryMiB:768},results:out.trim().split('\n').map(JSON.parse),memory:stats.MemUsage,stopMs:Math.round(performance.now()-began),exitCode:state.ExitCode};
 mkdirSync('artifacts/docker',{recursive:true});writeFileSync(`artifacts/docker/${image.split(':').at(-1)}${live?'-live':''}${a2a?'-a2a':''}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({smoke:'failed',name:error.name,message:error.message?.split('\n')[0]}));process.exitCode=1;}
finally{if(started)try{docker(['rm','-f',name]);}catch{}rmSync(tmp,{recursive:true,force:true});}
