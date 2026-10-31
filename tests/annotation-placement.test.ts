import { describe, expect, it } from 'vitest'
import { annotationPlacement, visibleAnnotationTargets } from '../src/client/annotation-placement.ts'
const point=(x:number,y:number)=>({left:x,right:x,top:y,bottom:y})
describe('marker-anchored annotation placement',()=>{
 it('opens right of the actual marker center and vertically centers a measured multiline popup',()=>{
  expect(annotationPlacement({left:290,right:310,top:390,bottom:410},{width:400,height:180},{width:1200,height:800})).toEqual({left:320,top:310,side:'right'})
 })
 it('uses the left side when the marker has insufficient space on its right',()=>{
  expect(annotationPlacement(point(900,400),{width:400,height:180},{width:1200,height:800})).toEqual({left:490,top:310,side:'left'})
 })
 it('chooses the larger side and clamps when neither side can fit',()=>{
  expect(annotationPlacement(point(280,200),{width:400,height:140},{width:600,height:400})).toEqual({left:184,top:130,side:'right'})
  expect(annotationPlacement(point(320,200),{width:400,height:140},{width:600,height:400})).toEqual({left:16,top:130,side:'left'})
 })
 it('keeps top and bottom edges inside the viewport when content height changes',()=>{
  expect(annotationPlacement(point(200,10),{width:300,height:190},{width:1000,height:400}).top).toBe(16)
  expect(annotationPlacement(point(200,390),{width:300,height:190},{width:1000,height:400}).top).toBe(194)
  expect(annotationPlacement(point(200,390),{width:300,height:110},{width:1000,height:400}).top).toBe(274)
 })
})
describe('intrinsic annotation target widths',()=>{
 it('fits targets using their measured widths and reserves no ellipsis when all fit',()=>{
  expect(visibleAnnotationTargets([34,42,58],180)).toBe(3)
  expect(visibleAnnotationTargets([34,42,58],179)).toBe(2)
 })
 it('reserves two independent menu capsules only when targets overflow',()=>{
  expect(visibleAnnotationTargets([40,40,40,40,40],200)).toBe(3)
  expect(visibleAnnotationTargets([34,80,34],170)).toBe(1)
  expect(visibleAnnotationTargets([100],80)).toBe(0)
  expect(visibleAnnotationTargets([],80)).toBe(0)
 })
})
