import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { buildTestPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
const script=fileURLToPath(new URL('../scripts/check-kernel.mjs',import.meta.url))
// A host C++ compiler is an external prerequisite: the Windows runners ship MSVC,
// not g++, so the suite skips these cases instead of failing on a missing tool.
const compiler=process.env.CXX?.trim()||'g++'
const hasCompiler=spawnSync(compiler,['--version'],{encoding:'utf8',windowsHide:true}).status===0
// Four real compiler invocations per case need more than the 5s unit-test
// default on hosted Windows. Each subprocess retains its own bounded timeout.
const testWithCompiler=(name:string,run:()=>void)=>
  (hasCompiler?test:test.skip)(name,{timeout:120_000},run)
function run(body:string, selfCheck=false) {
  const workspace=mkdtempSync(join(tmpdir(),'canness-kernel-check-'))
  const spec=parseSpec({operator_name:'add',operator_type:'elementwise',input_specs:[{name:'x',shape:['16'],dtype:'float32'}],output_specs:[{name:'y',shape:['16'],dtype:'float32'}],target_platform:{chip:'Ascend910B2'},performance_target:{metric:'kernel_time',target_us:50}})
  writeOperator(workspace,'gen-deadbeef',{kernel:body,host:'',api:'',plugin:''})
  const pkg=buildTestPackage(workspace,'gen-deadbeef',spec)
  if(selfCheck){
    const manifest=readFileSync(join(pkg,'manifest.json'))
    cpSync(join(pkg,'.contract-selfcheck'),join(workspace,'selfcheck'),{recursive:true})
    writeFileSync(join(workspace,'selfcheck','manifest.json'),manifest)
  }
  const result=spawnSync(process.execPath,[script,'--package',selfCheck?join(workspace,'selfcheck'):pkg,'--dtypes','float32,float16,bfloat16,int32','--compiler',compiler],{encoding:'utf8'})
  return {code:result.status,report:JSON.parse(result.stdout)}
}
const entry=(body:string)=>`#include "kernel_operator.h"\n#include "canness_tiling.h"\nusing namespace AscendC;\nextern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling){GET_TILING_DATA(t,tiling);LocalTensor<DTYPE_X> a,b,c;${body}}`
testWithCompiler('host syntax checker expands actual kernel across all requested dtypes',()=>{
  const result=run(entry('Add(a,b,c,16); Muls(a,b,static_cast<DTYPE_X>(2),16);'))
  expect(result).toMatchObject({code:0,report:{status:'pass',targetValidated:false}})
  expect(result.report.variants.map((v:{dtype:string,status:string})=>[v.dtype,v.status])).toEqual(['float32','float16','bfloat16','int32'].map(dtype=>[dtype,'pass']))
})

testWithCompiler('contract-style kernels receive forced tiling include without including it themselves',()=>{
  const source=entry('CannessAttrs attrs(tiling,t.workspaceSize); auto value=attrs.find("dim"); (void)value; Add(a,b,c,16);')
    .replace('#include "canness_tiling.h"\n','')
  const result=run(source)
  expect(result).toMatchObject({code:0,report:{status:'pass',targetValidated:false}})
  expect(result.report.variants).toHaveLength(4)
  expect(result.report.variants.every((v:{status:string})=>v.status==='pass')).toBe(true)
})
testWithCompiler('unsupported API and type mismatch are compiler errors, never silently accepted',()=>{
  const result=run(entry('UnsupportedTargetAPI(a,b,16);'))
  expect(result).toMatchObject({code:1,report:{status:'fail',targetValidated:false}})
  expect(result.report.variants.every((v:{status:string,diagnostics:string})=>v.status==='compile_error'&&v.diagnostics.includes('UnsupportedTargetAPI'))).toBe(true)
  expect(run(entry('LocalTensor<int64_t> wrong; Add(a,b,wrong,16);')).code).toBe(1)
})
testWithCompiler('stub restricts bitwise operations to explicit integer element types',()=>{
  expect(run(entry('And(a,b,c,16);')).code).toBe(1)
})

testWithCompiler('generated contract selfcheck compiles in all host dtype variants',()=>{
  expect(run(entry('Add(a,b,c,16);'),true)).toMatchObject({code:0,report:{status:'pass',targetValidated:false}})
})
