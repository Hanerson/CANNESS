---
{
  "schema_version": 1,
  "id": "cannbench-operator-resolution-keyword-schema",
  "title": "CANNBench 用 proto schema 首词解析算子，并通过关键字参数调用",
  "kind": "contract",
  "keywords": ["cann_matcher", "cann_spec", "op_runner", "func(**kwargs)", "scan_interfaces", "snake_case", "camelCase", "proto.yaml", "torch.ops.cann_bench"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/benches/cann_matcher.py#L43-L90",
      "sha256": "a7087c69254e1373398f743f0f1b44dbdad89d8ee09963c226687c0db2e216db"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/benches/cann_spec.py#L93-L100",
      "sha256": "6b6d241f896db588ef539b0332a2bd0862cb004ff3a612a3b1ec68f5277ddb0c"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/data/package_manager.py#L690-L731",
      "sha256": "4eab994807e3c3b67b93bc94ce059d926dd0b271afaafea0b49ea7b2d09aac87"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/eval/op_runner.py#L102-L108",
      "sha256": "6f67df4ca68d740944a08d117e320fb64dcc4b9726d33dda6a65bba721329202"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/eval/evaluator.py#L527-L556",
      "sha256": "50e83a5a69e1a091f3c01b0d2a88b9bae8c5ccfdca82f02fd255812ca4b833d6"
    }
  ]
}
---

**适用条件**：向 CANNBench（cannbench.com official-tasks）提交 `cann_bench` 包，或调试「算子已注册但评测器找不到 / 参数不匹配」时。

**结论**：`cann_matcher.py` 的 `load_ai_operator` 先查 `torch.ops.cann_bench`（golden whl），再查 `cann_bench` 模块（submission whl）；候选名是 `snake_case_candidates(operator_name)` + 小写名 + 原名 + schema 函数名。schema 函数名由 `cann_spec.get_function_name()` 用 `^(\w+)\s*\(` 从 `proto.yaml` 的 `schema:` 取首词。找到后，`op_runner` 以 `func(**updated_params)` 调用；`evaluator.py` 构建 `params` 时按 golden 签名的参数名填 tensor/attr/default。因此 C++ `m.def` 的 schema 必须与 proto/golden 的参数名逐字一致（包括 `rotaryMode`、`inputSize`、`batchFirst`、`projSize` 这类 camelCase），否则会因 unexpected keyword 失败。`package_manager.scan_interfaces()` 枚举 `dir(cann_bench)` 中不以 `_` 开头的 callable；包需要把算子镜像到模块全局，否则扫描为空或 ImportError。

**核对方式**：读 `load_ai_operator`、`get_function_name`、`scan_interfaces` 与 `func(**updated_params)` 四处；`python -c "import cann_bench; print([n for n in dir(cann_bench) if not n.startswith('_')])"`；用 `torch._C._jit_get_schemas_for_operator('cann_bench::<op>')` 对比 `proto.yaml`/golden 参数名；构造一个参数名不一致的 schema，确认评测器报 unexpected keyword。
