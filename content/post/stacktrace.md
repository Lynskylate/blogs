+++
title = "StackTrace的实现"
date = 2019-07-06T01:27:34+08:00
tags = ["backtrace"]
description = "naive的backtrace实现"
featuredImage = "https://cdn.nlark.com/yuque/0/2019/png/279676/1562340915972-aa11d229-a85b-4e1f-b355-87698b45e1df.png"
+++
# StackTrace的实现

## 简介

在python java这些语言中，一旦程序发生了异常，如下图，会打印异常发生时的调用栈，而在c/c++中如果需要实现类似的功能则要我们依靠libbacktrace之类的库去打印调用栈，

![image.png](https://cdn.nlark.com/yuque/0/2019/png/279676/1562305902441-6803d9fe-cf18-4f6f-9002-3fe3d0e4fadf.png)                                           

在c/c++中如何去实现一个类似libbacktrace这样的库来打印函数调用栈呢？本文将介绍一种naive的backtrace实现，讲解backtrace实现的原理。

## 追踪调用栈的基础-栈帧(stack frame)

栈帧(stack frame)保存着函数调用信息，如下图它存储于c内存布局中的栈区。

![image.png](https://cdn.nlark.com/yuque/0/2019/png/279676/1562340915972-aa11d229-a85b-4e1f-b355-87698b45e1df.png)                                           

栈帧是实现backtrace的核心关键，它会存储着函数调用时的局部变量同时记录了函数调用的上下文如返回地址，其具体布局如下图。

![image.png](https://cdn.nlark.com/yuque/0/2019/png/279676/1562341165791-150239ae-ef89-4a36-aba2-ef47c88ddb5d.png)                                           

ebp寄存器存储着栈基址指针，esp寄存器存储着当前栈顶指针，我们将ebp-esp之间的内存称为栈帧。



想要具体了解函数调用时，栈帧是如何变化的我们可以从汇编代码进行了解，我们将如下的代码进行反汇编

```c
// file:naive.c
int add(int a, int b){
    return a + b;
}

int main(int argc, char* argv[]){
    add(1,2);
}
// 反汇编命令 gcc -m32 -S -O0 -masm=intel naive.c
```

得到如下代码

```assembly
_add:                                   ## @add
	push	ebp
	mov	ebp, esp
	mov	eax, dword ptr [ebp + 12]
	add	eax, dword ptr [ebp + 8]
	pop	ebp
	ret
_main:                                  ## @main
	push	ebp
	mov	ebp, esp
	sub	esp, 24 # 预留栈空间存储局部变量
	mov	eax, dword ptr [ebp + 12]
	mov	ecx, dword ptr [ebp + 8]
	mov	dword ptr [esp], 1 # 设置局部变量1，2
	mov	dword ptr [esp + 4], 2
	mov	dword ptr [ebp - 4], eax ## 4-byte Spill
	mov	dword ptr [ebp - 8], ecx ## 4-byte Spill
    call	_add
	xor	ecx, ecx
	mov	dword ptr [ebp - 12], eax ## 4-byte Spill
	mov	eax, ecx
	add	esp, 24
	pop	ebp
	ret
```

在汇编中使用call _add时，它会将下一条地址推入栈中，并跳转至函数位置，即`call _add`相当于两条指令,`push pc; jmp _add`, 在使用call _add 指令后，此时栈顶(esp指向的地址)存储着xor ecx, ecx指令的地址。

在进入_add后，会将当前栈基址推入栈中，并通过mov ebp, esp形成新的栈帧。

如上图我们在32位的程序中可以通过[ebp+4]得到函数的返回地址，同时此时ebp指向的地址的值是保存的ebp值。

![image.png](https://cdn.nlark.com/yuque/0/2019/png/279676/1562346123718-20255897-804d-4f87-ab0a-3b01f0fff147.png)



更加详细的可以参考如下文章

[journey-to-the-stack](https://manybutfinite.com/post/journey-to-the-stack/)

[知乎:函数调用过程中栈到底是怎么压入和弹出的？](https://www.zhihu.com/question/22444939)

[stack frameout layout](https://eli.thegreenplace.net/2011/09/06/stack-frame-layout-on-x86-64)

## 获取调用栈信息

通过不断取寄存器ebp地址，我们能够获得一个个相连的栈帧，我们如何获取ebp的值呢，通过纯c代码难以实现这个目标，因此最终我使用了内联汇编来实现

```c++
typedef void* ptr_t;

inline ptr_t* get_ebp(){
	ptr_t* reg_ebp;

  asm volatile(
          "movq %%rbp, %0 \n\t"
          : "=r" (reg_ebp)
  );
	return reg_ebp;
}
```

但是我们通过函数的栈帧仍然无法获取完整的调用栈信息，我们需要还原究竟是哪个函数调用的，因此需要用过返回地址来获取调用函数。

所有函数其实都是有一个范围的，它存储在函数的代码区，我们通过记录函数的地址，并在其中寻找离返回地址最近并低于返回地址的函数地址就是其调用的函数。最初我是通过如下代码来记录函数地址的

```c
typedef struct {
        char *function_name;
        int *function_address;
}function_record_t;

typedef struct{
        int now_size;
        int max_size;
        function_record_t *records;
}function_record_vec_t;

function_record_vec_t vec;


int function_record_vec_init(function_record_vec_t *self){
        self->now_size = 0;
        self->max_size = 5;
        self->records = (function_record_t *)malloc(sizeof(function_record_t) * self->max_size);
        if(!self->records) return 0;
        return 1;
}

int function_record_vec_push(function_record_vec_t *self, function_record_t record){
        if(self->now_size == self->max_size){
                self->max_size = self->max_size << 1;
                self->records = (function_record_t *)realloc(self->records, sizeof(function_record_t) * self->max_size);                if(!self->records) return 0;
        }
        self->records[self->now_size++] = record;
        return 1;
}

// 寻找匹配函数信息，需要自己手动记录所有函数信息
function_record_t * find_best_record(int *return_address){
        for(int i=0; i<vec.now_size; i++){
                if(vec.records[i].function_address < return_address)
                {
                        return vec.records+i; // 返回最符合要求的函数地址
                }
        }
}

int main(void){
        function_record_vec_init(&vec);
        function_record_t main_f = {"main", &main};
        function_record_vec_push(&vec, main_f);
  			// 省略记录所有函数地址和名字的过程
        qsort(vec.records, vec.now_size, sizeof(function_record_t), compare_record);//地址从低到高排序
}
```

这种方式实在过于愚蠢，于是我开始寻找能够直接通过地址获取调用函数信息的api，linux系统中的[dladdr]([http://man7.org/linux/man-pages/man3/dladdr.3.html](http://man7.org/linux/man-pages/man3/dladdr.3.html))恰好能符合我的需求，因此上面的代码能够简化成下面的版本

```c++
void identify_function_ptr( void *func)  {
  Dl_info info;
  int rc;

  rc = dladdr(func, &info);

  if (!rc)  {
      printf("Problem retrieving program information for %x:  %s\n", func, dlerror());
  }

  printf("Address located in function %s within the program %s\n", info.dli_fname, info.dli_sname);
}
```

传入一个地址，就能够获取这个地址最有可能在哪个函数中。



最终代码如下

```c++
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <dlfcn.h>


void identify_function_ptr( void *func)  {
  Dl_info info;
  int rc;

  rc = dladdr(func, &info);

  if (!rc)  {
      printf("Problem retrieving program information for %x:  %s\n", func, dlerror());
  }

  printf("Address located in function %s within the program %s\n", info.dli_fname, info.dli_sname);

}

typedef void* ptr_t;


typedef struct _frame_t{
        ptr_t  return_address;
        ptr_t  ebp;
        struct _frame_t *next_frame;
}frame_t;




int frame_init(frame_t *self, ptr_t ebp, ptr_t return_address){
        self->return_address = return_address;
        self->ebp = ebp;
        self->next_frame = NULL;
}

void back_trace(){
        ptr_t* reg_ebp;

asm volatile(
        "movq %%rbp, %0 \n\t"
        : "=r" (reg_ebp)
);

        frame_t* now_frame=NULL;

        while(reg_ebp){
                frame_t *new_frame = (frame_t *) malloc(sizeof(frame_t));
                frame_init(new_frame,  (ptr_t)reg_ebp, (ptr_t)(*(reg_ebp+1)));
                new_frame->next_frame = now_frame;
                now_frame = new_frame;
                reg_ebp = (ptr_t)(*reg_ebp);
        }

        while(now_frame){
                identify_function_ptr((ptr_t)now_frame->return_address);
                now_frame = now_frame->next_frame;
        }
}


void two(){
        back_trace();
}

void one(){
        two();
}

int main(void){
        one();
}

```

其结果如下

![image.png](https://cdn.nlark.com/yuque/0/2019/png/279676/1562347223657-40006466-150a-4498-9846-7749fc9877af.png)



libbacktrace依赖libunwind来实现对调用栈的还原。上面的代码如果要对c++使用，需要使用demangle还原c++函数的符号名。
