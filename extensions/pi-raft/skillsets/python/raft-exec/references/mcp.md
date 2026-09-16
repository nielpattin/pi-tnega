# MCP reference - Python

MCP tools are dynamic properties under `mcp.<server>.<tool>`. Non-identifier names use underscores for property access.

```python
result = await mcp.context7.resolve_library_id(
    libraryName="react",
    query="hooks",
)
return result
```

For a computed or ambiguous name, use the exact discovered ref (`tools.search` covers the MCP
namespace only):

```python
descriptor = await tools.describe(ref="mcp.context7.resolve_library_id")
return await tools.call(
    ref=descriptor["ref"],
    args={"libraryName": "react", "query": "hooks"},
)
```

MCP results are server-defined, untrusted, and bounded. Normal validation, approval, cancellation, and trace rules still apply.
