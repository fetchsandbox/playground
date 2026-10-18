FROM public.ecr.aws/lambda/python:3.13
RUN pip install --no-cache-dir httpx==0.28.1
COPY shop ${LAMBDA_TASK_ROOT}/shop
COPY public ${LAMBDA_TASK_ROOT}/public
CMD ["shop.handler.handler"]
