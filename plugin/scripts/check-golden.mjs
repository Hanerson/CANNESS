#!/usr/bin/env node
// Compile the actual task golden reference; this never compiles or validates a device kernel.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

let temporary
let evidence = {}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = (status, details = {}) => console.log(JSON.stringify({status, kernelValidated:false, ...evidence, ...details}))
const str = value => '"' + [...Buffer.from(String(value), 'utf8')].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('') + '"'
const byteLength = value => Buffer.byteLength(value, 'utf8')
const dtype = name => {
  const type = name.toLowerCase().replace(/[^a-z0-9]/g,'')
  if (['float','float32','fp32'].includes(type)) return 'f32'
  if (['float16','fp16','half'].includes(type)) return 'f16'
  if (['bfloat16','bf16'].includes(type)) return 'bf16'
  if (['int32','i32'].includes(type)) return 'i32'
  if (['int64','i64'].includes(type)) return 'i64'
  throw Error(`unsupported fixture dtype: ${name}`)
}
const number = value => {
  if (value === 'nan') return 'std::numeric_limits<double>::quiet_NaN()'
  if (value === '+inf') return 'std::numeric_limits<double>::infinity()'
  if (value === '-inf') return '-std::numeric_limits<double>::infinity()'
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('floating fixtures require finite JSON numbers or nan/+inf/-inf strings')
  return Object.is(value,-0) ? '-0.0' : String(value)
}
const integer = (value,bits) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('integer fixtures outside safe JSON range require decimal strings')
  if (!/^-?\d+$/.test(String(value))) throw Error('invalid integer fixture')
  const parsed=BigInt(value), limit=1n << BigInt(bits-1)
  if(parsed < -limit || parsed >= limit) throw Error(`fixture outside int${bits} range`)
  return parsed === -(1n<<63n) ? '(-9223372036854775807LL - 1)' : `${parsed}LL`
}
try {
  const args = process.argv.slice(2), opts={}
  for(let i=0;i<args.length;i+=2){if(!['--package','--fixtures','--compiler'].includes(args[i]) || !args[i+1])throw Error('usage: check-golden.mjs --package DIR --fixtures JSON [--compiler g++]');opts[args[i]]=args[i+1]}
  if(!opts['--package'] || !opts['--fixtures']) throw Error('required --package and --fixtures')
  const pkg=resolve(opts['--package']), fixtures=JSON.parse(readFileSync(opts['--fixtures'],'utf8'))
  const manifest=JSON.parse(readFileSync(join(pkg,'manifest.json'),'utf8'))
  const {inputs,outputs}=manifest.tensorSpecs
  const golden=readFileSync(join(pkg,'golden.h'),'utf8')
  evidence = { files: Object.fromEntries(['golden.h','manifest.json','canness_tiling_host.h','canness_tiling_common.h'].map(name => [name,digest(readFileSync(join(pkg,name)))])), fixtureHash:digest(readFileSync(opts['--fixtures'])), compiler:opts['--compiler']??process.env.CXX??'g++' }
  if(/^\s*#\s*define\s+CANNESS_GOLDEN_PLACEHOLDER\b/m.test(golden))throw Error('golden is still a placeholder')
  if(!Array.isArray(fixtures.cases)||!fixtures.cases.length)throw Error('fixtures.cases must be nonempty')
  const abs=fixtures.absThreshold??1e-6, rel=fixtures.relThreshold??1e-6
  if(!Number.isFinite(abs)||abs<0||!Number.isFinite(rel)||rel<0)throw Error('invalid fixture tolerances')
  const count=tensor=>{const dimensions=tensor.shape.map(Number);if(!dimensions.every(n=>Number.isSafeInteger(n)&&n>0))throw Error('local fixtures require literal tensor shapes');return dimensions.reduce((a,b)=>a*b,1)}
  let body=''
  for(const [caseIndex,fixture] of fixtures.cases.entries()){
    if(fixture.inputs?.length!==inputs.length || fixture.expected?.length!==outputs.length)throw Error(`case ${caseIndex}: tensor count mismatch`)
    body+=' {\n'
    inputs.forEach((tensor,index)=>{
      const values=fixture.inputs[index], kind=dtype(tensor.dtype)
      if(!Array.isArray(values)||values.length!==count(tensor))throw Error(`case ${caseIndex}: input ${index} size mismatch`)
      const integerType=kind==='i64'||kind==='i32'
      const ctype=kind==='i64'?'int64_t':kind==='i32'?'int32_t':kind==='f32'?'float':'uint16_t'
      const literals=values.map(value=>integerType?integer(value,kind==='i64'?64:32):kind==='f32'?`static_cast<float>(${number(value)})`:`pack16(static_cast<float>(${number(value)}), ${kind==='bf16'})`)
      body+=`std::vector<${ctype}> raw${index}={${literals.join(',')}};\nstd::vector<float> in${index}; for(auto v:raw${index}) in${index}.push_back(${kind==='f16'||kind==='bf16'?`unpack16(v, ${kind==='bf16'})`:'static_cast<float>(v)'});\n`
    })
    const attrs={...(fixture.attrs??manifest.attrs??{})}
    for(const [name,rule] of Object.entries(manifest.attrsDerived??{})){
      const value=attrs[rule.source]
      if(rule.transform!=='log_positive_or_one'||typeof value!=='number')throw Error(`invalid derived fixture attribute ${name}`)
      attrs[name]=value>0?Math.log(value):1
    }
    const rows=Object.entries(attrs).map(([key,value])=>typeof value==='number'?`{${str(key)},GoldenAttrType::Number,${number(value)},false,nullptr,${byteLength(key)},0}`:typeof value==='boolean'?`{${str(key)},GoldenAttrType::Boolean,0,${value},nullptr,${byteLength(key)},0}`:typeof value==='string'?`{${str(key)},GoldenAttrType::String,0,false,${str(value)},${byteLength(key)},${byteLength(value)}}`:(()=>{throw Error('invalid fixture attr')})())
    const shape=fixture.shape??inputs[0].shape.map(Number)
    if(!Array.isArray(shape)||!shape.every(n=>Number.isSafeInteger(n)&&n>0))throw Error('invalid fixture shape')
    body+=`const float* in[]={${inputs.map((_,i)=>`in${i}.data()`).join(',')}}; const void* raw[]={${inputs.map((_,i)=>`raw${i}.data()`).join(',')}};\nconst char* types[]={${inputs.map(t=>str(t.dtype)).join(',')}};\nint64_t shape[]={${shape.join(',')}}; GoldenAttr attrs[]={${rows.join(',')||'{nullptr,GoldenAttrType::Missing,0,false,nullptr}'}};\nGoldenCtx ctx{shape,${shape.length},${integer(attrs.dim??0,64)},${attrs.keepdim?1:0},attrs,${rows.length},raw,types};\n`
    outputs.forEach((tensor,index)=>{
      const values=fixture.expected[index], kind=dtype(tensor.dtype), integral=kind==='i64'||kind==='i32'
      if(!Array.isArray(values)||values.length!==count(tensor))throw Error(`case ${caseIndex}: output ${index} size mismatch`)
      body+=`{std::vector<${integral?'int64_t':'float'}> actual(${values.length});\n`
      if(manifest.accuracyMode==='index-check')throw Error('local vector checker does not support index-check; provide an elementwise golden fixture package')
      body+=`#ifdef CANNESS_GOLDEN_BATCH\ncanness_golden::${integral?'evaluate_integer_all':'evaluate_all'}(ctx,${index},in,${inputs.length},actual.data(),actual.size());\n#else\nfor(int64_t i=0;i<static_cast<int64_t>(actual.size());++i) actual[i]=canness_golden::${integral?'evaluate_integer':'evaluate'}(\n${integral?'ctx,':'#ifdef CANNESS_GOLDEN_WITH_CONTEXT\nctx,\n#endif\n'}${index},in,${inputs.length},i);\n#endif\n`
      body+=`std::vector<${integral?'int64_t':'double'}> expected={${values.map(v=>integral?integer(v,kind==='i32'?32:64):number(v)).join(',')}};\nfor(size_t i=0;i<actual.size();++i){++compared;if(${integral?'actual[i]!=expected[i]':`!matches(actual[i],expected[i],${abs},${rel})`})++mismatches;} }\n`
    })
    body+=' }\n'
  }
  temporary=mkdtempSync(join(tmpdir(),'canness-check-golden-'))
  const source=join(temporary,'check.cpp'), binary=join(temporary,process.platform==='win32'?'check.exe':'check')
  writeFileSync(source,`#include <cmath>\n#include <cstdio>\n#include <cstring>\n#include <limits>\n#include <stdexcept>\n#include "canness_tiling_host.h"\n#define CANNESS_REQUIRE_SHAPE(c) do { if(!(c))throw std::runtime_error("golden shape assertion failed"); }while(0)\n#include "golden.h"\n
uint16_t pack16(float v,bool bf){uint32_t u;std::memcpy(&u,&v,4);if(bf){if((u&0x7fffffff)>0x7f800000)return (u>>16)|0x40;return (u+0x7fff+((u>>16)&1))>>16;}uint32_t sign=(u>>16)&0x8000,ex=(u>>23)&255,m=u&0x7fffff;if(ex==255)return sign|0x7c00|(m?0x200:0);int e=int(ex)-127+15;if(e>=31)return sign|0x7c00;if(e<=0){if(e < -10)return sign;m|=0x800000;int shift=14-e;return sign+((m+((1u<<(shift-1))-1)+((m>>shift)&1))>>shift);}uint32_t r=m+0xfff+((m>>13)&1);if(r&0x800000){r=0;if(++e>=31)return sign|0x7c00;}return sign|(e<<10)|(r>>13);}
float unpack16(uint16_t v,bool bf){uint32_t u;if(bf)u=uint32_t(v)<<16;else{uint32_t sign=(v&0x8000)<<16,ex=(v>>10)&31,m=v&1023;if(ex==0){if(!m)u=sign;else{int e=-14;while(!(m&1024)){m<<=1;--e;}u=sign|((e+127)<<23)|((m&1023)<<13);}}else u=sign|((ex==31?255:ex+112)<<23)|(m<<13);}float f;std::memcpy(&f,&u,4);return f;}
bool matches(double a,double b,double abs,double rel){if(std::isnan(a)||std::isnan(b))return std::isnan(a)&&std::isnan(b);if(std::isinf(a)||std::isinf(b))return a==b;return std::fabs(a-b)<=abs+rel*std::fabs(b);}
int main(){long long compared=0,mismatches=0;try{${body}}catch(const std::exception& e){std::fprintf(stderr,"%s",e.what());return 2;}std::printf("%lld %lld",compared,mismatches);return mismatches?1:0;}`)
  const compile=spawnSync(opts['--compiler']??process.env.CXX??'g++',['-std=c++17','-O2','-I',pkg,source,'-o',binary],{encoding:'utf8',timeout:60000,maxBuffer:2_000_000})
  if(compile.error||compile.status!==0){report('compile_error',{diagnostics:compile.error?.message??compile.stderr});process.exitCode=2}
  else {
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:60000,maxBuffer:2_000_000})
    const match=/^(\d+) (\d+)$/.exec(run.stdout)
    if(!match||run.error||![0,1].includes(run.status)){report('execution_error',{diagnostics:run.error?.message??run.stderr});process.exitCode=2}
    else {report(run.status===0?'pass':'mismatch',{compared:Number(match[1]),mismatches:Number(match[2]),cases:fixtures.cases.length,scope:'host golden against supplied reference vectors'});process.exitCode=run.status}
  }
}catch(error){report('invalid_input',{diagnostics:error.message});process.exitCode=2}
finally{if(temporary)rmSync(temporary,{recursive:true,force:true})}
