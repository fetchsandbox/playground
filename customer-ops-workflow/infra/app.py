#!/usr/bin/env python3
"""CDK app entrypoint: `cdk synth` / `cdk deploy` from infra/."""

import aws_cdk as cdk

from stack import CustomerOpsStack

app = cdk.App()
CustomerOpsStack(app, "CustomerOpsWorkflow")
app.synth()
