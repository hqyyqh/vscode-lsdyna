'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');

function req(v,m){if(!v)throw Error(m)}

function sha(v){return crypto.createHash('sha256').update(v).digest('hex')}

function canon(v){if(Array.isArray(v))return v.map(canon);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])]));return v}

function cj(v){return JSON.stringify(canon(v))}

function buildRuntime(h,a,e){
    for (const handoff of [h,e]) {
        const {contentSha256,...core}=handoff||{};
        req(contentSha256===sha(cj(core)),'scanner handoff content drift');
    }
    req(h?.contentSha256===a.source.handoffContentSha256&&h.descriptors?.length===1673&&e?.contentSha256===a.source.exactHandoffContentSha256&&e.descriptors?.length===5,'scanner handoff drift');const descriptors=[...h.descriptors,...e.descriptors].map(d=>canon({handoffId:d.handoffId,selectorResolutionId:d.selectorResolutionId||null,keyword:d.keyword,targetKind:d.targetKind,targetToken:d.targetToken,fieldName:d.fieldName,fieldType:d.fieldType,fieldIndex:d.fieldIndex,position:d.position,width:d.width,recordMode:d.recordMode,dataRecordOrdinal:d.dataRecordOrdinal,titleCardCount:d.titleCardCount,valueDomain:d.valueDomain})).sort((x,y)=>x.keyword.localeCompare(y.keyword));req(new Set(descriptors.map(d=>d.keyword)).size===1678,'combined scanner duplicate keyword');const core=canon({schemaVersion:1,kind:'dynasense-family-definition-scanner-runtime',source:{handoffContentSha256:h.contentSha256,exactHandoffContentSha256:e.contentSha256,implementationContractVersion:2},permissions:a.permissions,summary:{descriptors:descriptors.length,base:descriptors.filter(d=>d.titleCardCount===0).length,title:descriptors.filter(d=>d.titleCardCount===1).length,labelCapable:descriptors.filter(d=>d.valueDomain.kind.includes('label')).length,integerOnly:descriptors.filter(d=>d.valueDomain.kind==='positive-integer').length,exact:5},descriptors});return{...core,contentSha256:sha(cj(core))}}

module.exports = { buildRuntime };
