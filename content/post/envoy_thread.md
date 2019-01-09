+++
title = "Envoy的线程模型[翻译]"
date = 2019-01-09T23:18:43+08:00
tags = ["envoy", "Service Mesh"]
description = "本文是matt对于envoy底层线程机制介绍的翻译"
featuredImage = "https://cdn-images-1.medium.com/max/800/1*mNPG4j0QsUk_4J5milHAKQ.png"
+++
# Envoy threading Model

关于envoy 代码的底层文档相当稀少。为了解决这个问题我计划编写一系列文档来描述各个子系统的工作。由于是第一篇， 请让我知道你希望其他主题覆盖哪些内容。

一个我所了解到最共同的技术问题是关于envoy使用的线程模型的底层描述，这篇文章将会描述envoy如何使用线程来处理连接的(how envoy maps connections to threads)， 同事也会描述Thread Local Storage(TLS)系统是如何使内部代码平行且高效的。

## Threading overview

![img](https://cdn-images-1.medium.com/max/800/1*mNPG4j0QsUk_4J5milHAKQ.png)

Figure 1: Threading overview

如同图一所示，envoy使用了三中不同类型的线程。

- **Main**: 这个线程管理了服务器本身的启动和终止, 所有[xDS API](https://github.com/envoyproxy/data-plane-api/blob/master/XDS_PROTOCOL.md)的处理(包括DNS, 健康检查(health checking) 和通常的集群管理), running, 监控刷新(stat flushing), 管理界面 还有 通用的进程管理(signals, [hot restart](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/hot_restart.html)。在这个线程中发生的所有事情都是异步和非阻塞的(non blocking)。通常，主线程用来协调所有不需要大量cpu完成的关键功能。这允许大部分代码编写的如同单线程一样。

- **Worker** 在envoy系统中，默认为每个硬件(every harware)生成一个worker线程（可以通过--concurrency参数控制),每个工作线程运行一个无阻塞的事件循环(event loop)，for listening on every listener (there is currently no listener sharding), accept 新的连接，为每个连接实例化过滤栈，以及处理这个连接生命周期的所有io。同时，也允许所有连接代码编写的如同单线程一样。

- **File flusher** Envoy 写入的每个文件现在都有一个单独的block的刷新线程。这是因为使用O_NONBLOCK在写入文件系统有时也会阻塞。当Worker线程需要写入文件时，这个数据实际上被移动至in-memory buffer中，最终会被File Flusher线程刷新至文件中。envoy的代码会在一个worker试图写入memory buffer时锁住所有worker。还有一些其他的会在下面讨论。

## 连接处理

如上所述， 所有worker线程都会监听端口而没有任何分片，因此，内核智能的分配accept的套接字给worker进程。现代内核一般都很擅长这一点，在开始使用其他监听同一套接字的其他线程之前，内核使用io 优先级提升等特性来分配线程的工作，同样的还有不适用spin-lock来如理所有请求。

一旦woker accept了一个连接，那么这个连接永远不会离开这个worker(一个连接只由同一worker进行处理), 所有关于连接的处理都将会在worker线程内进一步处理，包括任何转发行为。这有一些重要的含义：

- Envoy连接池中都是worker线程，因此通过http/2 连接池每次只与上游主机建立一个连接，如果有4个worker，那在稳定状态将只有四个http/2连接与上游主机进行连接。

- Envoy以这种方式工作的原因在于这样几乎所有的代码都可以如同单线程一样以没有锁的方式进行编写。这个设计使得大部分代码易于编写和扩展。

- 从内存和连接池效率的角度来看，调整 - concurrency选项实际上非常重要。拥有比所需要的worker更多的worker将会浪费大量的内存，造成大量空置的连接，并导致较低的连接池命中率。在lyft，envoy以较低的concurerency运行，性能大致与他们旁边的服务相匹配。

## non-blocking意味着什么
到目前为止，在讨论主线程和worker线程时我们已经多次使用术语'non-blocking'.几乎所有代码都是假设没有阻塞的情况下进行编写。但是，这并非完全正确(哪里有完全正确的东西)，Envoy确实使用了一些process wide locks.

- 正如上述，如果在写入访问日志， 所有worker都会获得同样的锁在将访问日志填充至内存缓存[^1]前。锁应当保持较短的时间，但是这个锁有可能在高并发和高吞吐量时进行竞争。
- Envoy使用了一个非常复杂的系统来处理线程本地的统计数据，这将是另一个帖子的主题，我简要的介绍一下，作为线程本地统计处理的一部分，它有时会获得一个对于中央统计商店[^2]的锁, 这个锁不应当被经常竞争。
- 主线程定期需要协调所有worker线程。这是通过主线程发不到工作线程来完成的。发布过程需要lock来锁定消息队列。这个锁不应当被高度争用，但从技术上可以进行阻止。
- 当envoy记录日志至stderr， 它将会获得process wide lock。 通常来说， envoy 本地日志被认为对于性能来说是糟糕的，所以没有改善该过程的想法。
- 还有一切其他随机锁。但他们都不在影响性能的过程中，也永远不当被争用。

## 线程局部变量[^3]

由于envoy将主线程的职责和worker线程的职责完全分开，需要在主线程完成复杂的处理同时使每个worker线程高度可用。本节将介绍Envoy的高级线程本地存储（TLS）系统。在下一节中，我将描述如何使用它来处理集群管理。

如已经描述的那样，主线程基本上处理Envoy过程中的所有管理/控制平面功能。（控制平面在这里有点过载，但在特使程序本身考虑并与工人做的转发进行比较时，似乎是合适的）。主线程进程执行某些操作是一种常见模式，然后需要使用该工作的结果更新每个工作线程，并且工作线程不需要在每次访问时获取锁定

![img](https://cdn-images-1.medium.com/max/1000/1*fyx9IJBwbGDVtK_LhwQB6A.png)

Envoy的TLS系统工作如下:

- 运行在主线程的代码分配了一个线程范围的TLS插槽[^4]，虽然是abstracted的，但实际上时允许o(1)访问的索引
- 主线程可以设置任意数据在slot中，当它完成时，这个数据将会发送到所有worker作为一个正常的事件循环
- 工作线程可以从TLS插槽中读取获取它所能获取的局部数据。

虽然非常简单，但它非常强大与[只读副本更新锁](https://en.wikipedia.org/wiki/Read-copy-update)类似.(实质上，worker线程在工作时从不会看到插槽的数据发生任何改变， 变化只发生在event切换的时候[^5])， Envoy用两种不同的方式来使用它:

- 存储不同的数据在每个worker上，获取时不需要任何锁
- 通过将指向只读全局数据的共享指针存储到每个worker上，从而，每个worker具有该数据的引用计数，该计数在工作时不会递减。仅当所有worker查询和读取新的共享数据时会将原数据摧毁，这与RCU相同。

## 集群更新线程

在本节中，我将描述TLS如何用于集群管理。群集管理包括xDS API处理和DNS以及运行状况检查。

![img](https://cdn-images-1.medium.com/max/800/1*R-U8hs34U93Yj1TzbhwE5w.png)

[^1]: 原文 in-memory buffer

[^2]: central "stat store"

[^3]: Thread Local Storage(TLS)

[^4]: 原文 slot

[^5]: 原文 Change only happens during the quiescent period between work events



