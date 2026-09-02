import {describe, expect, it} from 'vitest'

import { EffectStack } from '../src/effect-stack.js'

describe("EffectStackTest",()=>{
    it("DisporseTest",async () =>{
        const calls:String[] = []
        let effectStack = new EffectStack()
        
        effectStack.add(() => {
            calls.push("first")
        })

        effectStack.add(async () => {
            await Promise.resolve("hello")
            calls.push("second")
        })

        await effectStack.dispose()
        console.log(calls)
        expect(calls).toEqual(["second","first"])
    }) 
})