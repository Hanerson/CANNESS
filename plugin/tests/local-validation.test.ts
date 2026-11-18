import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// A host C++ compiler is an external prerequisite: the Windows runners ship MSVC,
// not g++, so the suite skips these cases instead of failing on a missing tool.
const compiler = process.env.CXX?.trim() || 'g++'
const hasCompiler = spawnSync(compiler, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
const testWithCompiler = hasCompiler ? test : test.skip
import { buildTestPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'

function fixture(golden: string, dtype = 'float32') {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-local-'))
  const spec = parseSpec({operator_name:'identity',operator_type:'elementwise',
    input_specs:[{name:'x',shape:['3'],dtype}], output_specs:[{name:'y',shape:['3'],dtype}],
    target_platform:{chip:'Ascend910B2'},performance_target:{metric:'kernel_time',target_us:50}})
  const source = writeOperator(workspace,'gen-deadbeef',{kernel:'void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {}',host:'',api:'',plugin:''})
  writeFileSync(join(source,'golden.h'),golden)
  return {workspace,pkg:buildTestPackage(workspace,'gen-deadbeef',spec)}
}
function check(pkg:string,workspace:string,inputs:unknown[],expected:unknown[]) {
  const path=join(workspace,'fixtures.json');writeFileSync(path,JSON.stringify({cases:[{inputs:[inputs],expected:[expected]}]}))
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/check-golden.mjs', import.meta.url)),'--package',pkg,'--fixtures',path,'--compiler',compiler],{encoding:'utf8'})
  return {status:result.status, report:JSON.parse(result.stdout)}
}
testWithCompiler('local check compiles real batch golden and compares nonfinite reference vectors',()=>{
  const {pkg,workspace}=fixture('#define CANNESS_GOLDEN_BATCH\nnamespace canness_golden { inline void evaluate_all(GoldenCtx,int,const float* const* in,int,float* out,int64_t n){for(int64_t i=0;i<n;++i)out[i]=in[0][i];} }')
  expect(check(pkg,workspace,['nan','+inf','-inf'],['nan','+inf','-inf'])).toMatchObject({status:0,report:{status:'pass',kernelValidated:false,compared:3}})
  expect(check(pkg,workspace,[1,2,3],[1,2,4])).toMatchObject({status:1,report:{status:'mismatch',mismatches:1}})
})
testWithCompiler('local check preserves exact int64 raw input and reference values',()=>{
  const {pkg,workspace}=fixture('#include <cstring>\nnamespace canness_golden {inline int64_t evaluate_integer(GoldenCtx c,int,const float* const*,int,int64_t i){int64_t v;std::memcpy(&v,static_cast<const char*>(c.raw_inputs[0])+i*8,8);return v;} }','int64')
  expect(check(pkg,workspace,['9007199254740993','-9223372036854775808','9223372036854775807'],['9007199254740993','-9223372036854775808','9223372036854775807'])).toMatchObject({status:0,report:{status:'pass'}})
})

testWithCompiler('context golden receives float16 raw buffers and attrs with half rounding',()=>{
  const {pkg,workspace}=fixture('#define CANNESS_GOLDEN_WITH_CONTEXT\nnamespace canness_golden {inline float evaluate(GoldenCtx c,int,const float* const* in,int,int64_t i){CANNESS_REQUIRE_SHAPE(c.rank==1 && c.shape[0]==3);return in[0][i];} }','float16')
  expect(check(pkg,workspace,[65504,1.0001,'nan'],[65504,1,'nan'])).toMatchObject({status:0,report:{status:'pass'}})
})
testWithCompiler('syntax errors are reported as compile errors without validating a kernel',()=>{
  const {pkg,workspace}=fixture('this is not valid C++')
  expect(check(pkg,workspace,[1,2,3],[1,2,3])).toMatchObject({status:2,report:{status:'compile_error',kernelValidated:false}})
})

testWithCompiler('context attrs preserve embedded NUL bytes and explicit UTF-8 lengths',()=>{
  const {pkg,workspace}=fixture('#define CANNESS_GOLDEN_WITH_CONTEXT\nnamespace canness_golden {inline float evaluate(GoldenCtx c,int,const float* const* in,int,int64_t i){CANNESS_REQUIRE_SHAPE(c.attr_count==1 && c.attrs[0].nameLength==3 && c.attrs[0].stringLength==3 && c.attrs[0].string[1]==0 && c.attrs[0].string[2]==\'y\');return in[0][i];} }')
  const manifest=JSON.parse(readFileSync(join(pkg,'manifest.json'),'utf8'));manifest.attrs={'a\u0000b':'x\u0000y'};writeFileSync(join(pkg,'manifest.json'),JSON.stringify(manifest))
  expect(check(pkg,workspace,[1,2,3],[1,2,3])).toMatchObject({status:0,report:{status:'pass'}})
})
