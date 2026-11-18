#!/usr/bin/env node
// Compile actual kernel source against a bounded host API model, not a device toolkit.
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const types={float32:'float',float16:'half',bfloat16:'bfloat16_t',int32:'int32_t',int64:'int64_t'}
const normalized=name=>({float:'float32',fp32:'float32',half:'float16',fp16:'float16',bf16:'bfloat16',i32:'int32',i64:'int64'}[name.toLowerCase().replace(/[^a-z0-9]/g,'')]??name.toLowerCase().replace(/[^a-z0-9]/g,''))
let temporary
try {
  const args=process.argv.slice(2), opts={}
  for(let i=0;i<args.length;i+=2){if(!['--package','--dtypes','--compiler'].includes(args[i])||!args[i+1])throw Error('usage: check-kernel.mjs --package DIR --dtypes float32,float16,bfloat16,int32 [--compiler g++]');opts[args[i]]=args[i+1]}
  if(!opts['--package']||!opts['--dtypes'])throw Error('--package and --dtypes required')
  const pkg=resolve(opts['--package']), dtypes=opts['--dtypes'].split(',').map(normalized)
  if(!dtypes.length||new Set(dtypes).size!==dtypes.length||dtypes.some(type=>!Object.hasOwn(types,type)))throw Error('dtypes must be unique supported dtype names')
  const files={}
  let totalBytes=0
  const inspect=path=>{
    const stat=lstatSync(path)
    if(stat.isSymbolicLink())throw Error('package symlinks are not supported by local syntax validation')
    if(stat.isDirectory()){for(const name of readdirSync(path))inspect(join(path,name));return}
    if(!stat.isFile())throw Error('package contains non-regular file')
    if(path.split(/[\\/]/).at(-1)==='kernel_operator.h')throw Error('kernel_operator.h is reserved for the bounded local stub; remove packaged toolkit overrides')
    totalBytes+=stat.size
    if(totalBytes>50_000_000)throw Error('package exceeds local 50MB copy limit')
    files[relative(pkg,path).replaceAll('\\','/')]=sha(readFileSync(path))
  }
  inspect(pkg)
  const manifest=JSON.parse(readFileSync(join(pkg,'manifest.json'),'utf8'))
  if(!existsSync(join(pkg,'op_kernel/kernel.cpp')))throw Error('missing op_kernel/kernel.cpp')
  const original=readFileSync(join(pkg,'canness_tiling.h'),'utf8')
  const originalInput=normalized(manifest.tensorSpecs.inputs[0].dtype)
  if(manifest.tensorSpecs.inputs.some(t=>normalized(t.dtype)!==originalInput))throw Error('variant checking requires uniform input dtypes')
  const output=normalized(manifest.tensorSpecs.outputs[0].dtype)
  if(!Object.hasOwn(types,output))throw Error('unsupported output dtype')
  const stubPath=fileURLToPath(new URL('../templates/local-validation/kernel_operator.h',import.meta.url))
  const stub=readFileSync(stubPath)
  temporary=mkdtempSync(join(tmpdir(),'canness-kernel-syntax-'))
  const root=join(temporary,'package')
  cpSync(pkg,root,{recursive:true})
  writeFileSync(join(root,'kernel_operator.h'),stub)
  const compiler=opts['--compiler']??process.env.CXX??'g++', variants=[], deadline=Date.now()+100_000
  for(const dtype of dtypes){
    let shim=original
    for(const [alias,type] of [['DTYPE_X',types[dtype]],['DTYPE_Y',types[output===originalInput?dtype:output]]]){
      const pattern=new RegExp(`using\\s+${alias}\\s*=\\s*[^;]+;`)
      if(!pattern.test(shim))throw Error(`package tiling shim missing ${alias} alias`)
      shim=shim.replace(pattern,`using ${alias} = ${type};`)
    }
    writeFileSync(join(root,'canness_tiling.h'),shim)
    const result=spawnSync(compiler,['-std=c++17','-fsyntax-only','-include',join(root,'kernel_operator.h'),'-include',join(root,'canness_tiling.h'),'-I',root,'-I',dirname(join(root,'op_kernel/kernel.cpp')),join(root,'op_kernel/kernel.cpp')],{encoding:'utf8',timeout:Math.max(1,Math.min(25_000,deadline-Date.now())),maxBuffer:2*1024*1024,windowsHide:true})
    variants.push({dtype,status:result.status===0&&!result.error?'pass':'compile_error',diagnostics:result.error?.message??result.stderr.slice(-16000)})
  }
  const pass=variants.every(variant=>variant.status==='pass')
  console.log(JSON.stringify({status:pass?'pass':'fail',targetValidated:false,scope:'host syntax with bounded API stub; unsupported APIs require target compiler diagnosis',variants,files,stubHash:sha(stub),compiler}))
  process.exitCode=pass?0:1
}catch(error){console.log(JSON.stringify({status:'invalid_input',targetValidated:false,diagnostics:error.message}));process.exitCode=2}
finally{if(temporary)rmSync(temporary,{recursive:true,force:true})}
