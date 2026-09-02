export type Disposer = () => void | Promise<void>

export class EffectStack{
    private readonly disposers:Disposer[] = []

    add(disposer:Disposer){
        this.disposers.push(disposer)
    }

    async dispose():Promise<void>{
        for (let index = this.disposers.length - 1; index>=0; index-=1){
            const disposer = this.disposers[index]
            if (disposer !== undefined){
                await disposer()
            }
        }
    }
}