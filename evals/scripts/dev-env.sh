# Exports the dev stack settings the live eval scripts read.
#   source evals/scripts/dev-env.sh
# Embedding and vector settings are copied from the ingestion stage runner,
# so the eval queries exactly the index and model the pipeline writes.
_region=ap-southeast-1
_fn=$(aws lambda list-functions --region $_region \
  --query "Functions[?contains(FunctionName,'IngestionStageRunner')].FunctionName" --output text)
eval "$(aws lambda get-function-configuration --region $_region --function-name "$_fn" \
  --query 'Environment.Variables' --output json \
  | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const k of ["EMBEDDING_REGION","EMBEDDING_MODEL_ID","EMBEDDING_DIMENSIONS","VECTOR_INDEX_ARN","VECTOR_REGION","DOCUMENTS_TABLE","CHUNKS_TABLE","GAMES_TABLE","CONTENT_TABLE"]) if(v[k]) console.log(`export ${k}=${JSON.stringify(v[k])}`)')"
# The dev API URL comes from the stack, so it is never written into the repo.
export API_BASE=$(aws cloudformation describe-stacks --region $_region --stack-name BgrDevStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontApiUrl'].OutputValue" --output text)
unset _region _fn
