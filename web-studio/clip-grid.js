// Arrangement clip-edit preference. Time edits/locators retain their separate grids.
export const CLIP_GRID_KEY='opus-arrangement-clip-grid';
export const CLIP_GRIDS=[
 {value:0,label:'Off'}, {value:8,label:'2 Bars'}, {value:4,label:'1 Bar'},
 {value:2,label:'1/2'}, {value:1,label:'1/4'}, {value:.5,label:'1/8'},
 {value:1/3,label:'1/8 Triplet'}, {value:.25,label:'1/16'},
 {value:1/6,label:'1/16 Triplet'}, {value:.125,label:'1/32'},
 {value:1/12,label:'1/32 Triplet'}, {value:.0625,label:'1/64'}
];
export function clipGrid(value){if(!CLIP_GRIDS.some(g=>g.value===value))throw Error('Choose an available Arrangement clip grid.');return value;}
export function readClipGrid(storage){try{return clipGrid(Number(storage.getItem(CLIP_GRID_KEY)??.25));}catch{return .25;}}
export function snapClipBeat(value,grid=.25,{ceil=false}={}){
 clipGrid(grid);if(!Number.isFinite(value))throw Error('Choose a finite clip position.');
 if(grid===0)return value;
 return (ceil?Math.ceil(value/grid-1e-9):Math.round(value/grid))*grid;
}
export function clipGridTicks(view,grid){
 clipGrid(grid);if(!grid)return [];
 let step=grid;while(view.span/step>96)step*=2;
 const ticks=[];for(let i=Math.ceil((view.start-1e-9)/step);i*step<view.end-1e-9;i++)ticks.push((i*step-view.start)/view.span*100);
 return ticks;
}
export function clipNudge(grid){return clipGrid(grid)||.0625;}
