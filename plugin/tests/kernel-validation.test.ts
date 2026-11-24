import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// CAN-102: the real device compiler puts string literals in global memory
// (`const __gm__ char[N]`). CANN 8.0.1/9.2.1 expand __gm__ to an attribute that
// does not participate in overload resolution, so `find(const char*)` plus a
// `find(const __gm__ char*)` overload is a redeclaration. A single member
// template must bind the GM key, the string literal and a local char[] under
// both spellings of __gm__.
const clang=process.env.CLANGXX?.trim()||'clang++'
const hasClang=spawnSync(clang,['--version'],{encoding:'utf8',windowsHide:true}).status===0
// Some clang targets (notably the MSVC x86 target used on CI Windows) reject
// address_space(1) outright. Probe the host model before treating that case as
// applicable; the attribute-model case works on every clang target.
function clangModelsAddressSpace(clangPath:string):boolean{
  const dir=mkdtempSync(join(tmpdir(),'canness-gm-model-'))
  try{
    const probe=join(dir,'probe.cpp')
    writeFileSync(probe,[
      '#define __gm__ __attribute__((address_space(1)))',
      '#include <cstdint>',
      'static const __gm__ char key[] = "pattern";',
      'int main() { return key[0]; }',
    ].join('\n'))
    return spawnSync(clangPath,['-std=c++17','-fsyntax-only',probe],{encoding:'utf8',windowsHide:true}).status===0
  }finally{rmSync(dir,{recursive:true,force:true})}
}
// Some Windows runners ship a clang older than the installed MSVC STL accepts
// (e.g. LLVM 20 with an STL requiring clang 22). The probe includes <cstdint>
// like the generated header does, so those runners skip instead of failing on
// the toolchain mismatch.
function clangCompilesHostStl(clangPath:string):boolean{
  const dir=mkdtempSync(join(tmpdir(),'canness-clang-stl-'))
  try{
    const probe=join(dir,'probe.cpp')
    writeFileSync(probe,'#include <cstdint>\nint main() { return 0; }\n')
    return spawnSync(clangPath,['-std=c++17','-fsyntax-only',probe],{encoding:'utf8',windowsHide:true}).status===0
  }finally{rmSync(dir,{recursive:true,force:true})}
}
const clangCompilesStl=hasClang&&clangCompilesHostStl(clang)
const clangModelsGm=clangCompilesStl&&clangModelsAddressSpace(clang)
const testWithClangGm=(clangModelsGm?test:test.skip)
const testWithClang=(clangCompilesStl?test:test.skip)
function compileGmProbe(gmDefinition:string){
  const workspace=mkdtempSync(join(tmpdir(),'canness-gm-find-'))
  const spec=parseSpec({operator_name:'add',operator_type:'elementwise',input_specs:[{name:'x',shape:['16'],dtype:'float16'}],output_specs:[{name:'y',shape:['16'],dtype:'float16'}],target_platform:{chip:'Ascend910B2'},performance_target:{metric:'kernel_time',target_us:50}})
  writeOperator(workspace,'gen-deadbeef',{kernel:'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {GET_TILING_DATA(t,tiling);}',host:'',api:'',plugin:''})
  const pkg=buildTestPackage(workspace,'gen-deadbeef',spec)
  const fake=join(workspace,'fake-include')
  mkdirSync(fake)
  writeFileSync(join(fake,'kernel_operator.h'),[
    '#pragma once',
    '#include <cstdint>',
    `#define __gm__ ${gmDefinition}`,
    '#define __aicore__',
    '#define __global__',
    '#define GM_ADDR __gm__ uint8_t*',
    // The probe only exercises attribute/address-space lookup, so a float alias
    // avoids clang targets that do not support _Float16.
    'using half = float;',
  ].join('\n'))
  writeFileSync(join(workspace,'probe.cpp'),[
    '#include "kernel_operator.h"',
    '#include "canness_tiling.h"',
    'static const __gm__ char gmKey[] = "pattern";',
    'void probe(GM_ADDR tiling) {',
    '  CannessAttrs attrs(tiling, 0);',
    '  const auto byGmKey = attrs.find(gmKey);',
    '  const auto byLiteral = attrs.find("scale");',
    '  char local[8] = {\'e\',\'n\',\'a\',\'b\',\'l\',\'e\',\'d\',\'\\0\'};',
    '  const auto byLocal = attrs.find(local);',
    '  (void)byGmKey; (void)byLiteral; (void)byLocal;',
    '}',
  ].join('\n'))
  return spawnSync(clang,['-std=c++17','-fsyntax-only','-Wno-unknown-attributes','-I',fake,'-I',pkg,join(workspace,'probe.cpp')],{encoding:'utf8',windowsHide:true})
}
testWithClangGm('GM-qualified keys bind to the find template (CAN-102)',{timeout:60_000},()=>{
  const result=compileGmProbe('__attribute__((address_space(1)))')
  expect(result.stderr).not.toMatch(/address space|__gm__/u)
  expect(result.status,result.stderr).toBe(0)
})
testWithClang('attribute __gm__ keeps find a single member (CANN 8.0.1 / 9.2.1)',{timeout:60_000},()=>{
  const result=compileGmProbe('__attribute__((cce_global))')
  expect(result.stderr).not.toMatch(/redeclared|__gm__/u)
  expect(result.status,result.stderr).toBe(0)
})
