"""DCAC for Hermes Agent: recurring buys of tokenized stocks, crypto and Bankr index tokens on Base."""

from . import tools


def register(ctx):
    for name, schema in tools.load_schemas().items():
        ctx.register_tool(name=name, toolset="dcac", schema=schema, handler=tools.handler(name))
