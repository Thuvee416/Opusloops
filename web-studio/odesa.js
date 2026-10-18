// Odesa names OPUS model configurations, not independently trained base models.
export const ODESA_MODEL={id:'tempo',name:'Tempo',version:'1.0',provider:'Amazon Bedrock',providerModelId:'amazon.nova-pro-v1:0',providerModelName:'Amazon Nova Pro'};
export function odesaModelProfile(providerModelId){
 return providerModelId===ODESA_MODEL.providerModelId?{...ODESA_MODEL}:{id:'configured',name:'Configured Model',version:null,provider:'Amazon Bedrock',providerModelId,providerModelName:providerModelId};
}

// Reserved launch families; they are not selectable or available models.
export const ODESA_PLANNED_MODELS=[{id:'forte',name:'Forte',role:'Deeper Production',status:'planned'},{id:'prelude',name:'Prelude',role:'Experimental Preview',status:'planned'}];
