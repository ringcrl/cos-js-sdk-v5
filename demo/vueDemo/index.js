window.onload = async function () {
  const config = await fetch('/config').then(res => res.json());

  const { bucket, region, secretId, secretKey, } = config

  const Bucket = bucket;  /* 存储桶 */
  const Region = region;  /* 存储桶所在地域，必须字段 */
  // SecretId 和 SecretKey请登录 https://console.cloud.tencent.com/cam/capi 进行查看和管理
  const cos = new COS({
    SecretId: secretId,
    SecretKey: secretKey,
  });

  /*
    实现了以下功能
    - 文件列表
    - 上传文件
    - 上传文件夹
    - 下载文件
    - 删除文件
  */
  const vm = new Vue({
    el: '#app',
    data() {
      return {
        columns: [
          { label: '名称', value: 'Key' },
          { label: '大小', value: 'Size' },
          { label: '修改时间', value: 'LastModified' },
          { label: '操作', value: 'action' }
        ],
        list: [],
        Prefix: '',
        Marker: '',
        hasMore: false,
        isUploding: false,
        uploadingInfo: {
          prefix: '',
          name: '',
          percent: '',
          speed: '',
          lastTime: '',
          fileSize: '',
          avgSpeed: '',
        },
        currPrefixUnfinishedList: [],
        uploadConfig: 'default',
        networkSpeed: '测速中...'
      }
    },
    computed: {
      // 面包屑导航条
      navList() {
        const prefixes = this.Prefix.split('/').filter(Boolean);
        const folders = prefixes.map((item, index) => {
          return {
            name: item,
            Prefix: prefixes.slice(0, index + 1).join('/') + '/',
          };
        });
        return [{ name: Bucket, Prefix: '' }].concat(folders);
      },
    },
    async created() {
      this.getFileList();
      this.getCurrPrefixUnfinishedList()
      speed = await this.getDownloadSpeed()
      this.networkSpeed = `${speed}MB/s`
    },
    methods: {
      // 查询文件列表
      getFileList(loadMore) {
        const { Prefix, Marker } = this;
        cos.getBucket({
          Bucket, /* 必须 */
          Region,     /* 存储桶所在地域，必须字段 */
          Prefix,              /* 非必须 */
          Marker,       /* 非必须 */
          Delimiter: '/',            /* 非必须 */
        }, (err, data) => {
          if (err) {
            console.log(err);
            return;
          }
          const folder = data.CommonPrefixes.map((item) => {
            return {
              Prefix: item.Prefix,
              name: item.Prefix.replace(Prefix, '').slice(0, -1),
              isDir: true,
            }
          });
          const files = data.Contents.filter((item) => !item.Key.endsWith('/'))
            .map((item) => {
              return {
                ...item,
                name: item.Key.replace(Prefix, ''),
              }
            });
          const list = folder.concat(files);
          this.hasMore = data.IsTruncated;
          this.Marker = data.NextMarker || '';
          if (loadMore) {
            this.list = [...this.list, ...list];
          } else {
            this.list = list;
          }
        });
      },
      // 点击面包屑
      navClick(item) {
        this.openFolder(item.Prefix);
      },
      // 打开文件夹
      openFolder(prefix) {
        this.Prefix = prefix;
        this.hasMore = false;
        this.Marker = '';
        this.getFileList();
        this.getCurrPrefixUnfinishedList();
      },
      // 查询当前路径是否有未上传完成分片
      getCurrPrefixUnfinishedList() {
        cos.multipartList({
          Bucket: Bucket, /* 必须 */
          Region: Region,     /* 存储桶所在地域，必须字段 */
          Prefix: this.Prefix,                        /* 非必须 */
        }, async (err, data) => {
          if (err) {
            return console.log(err)
          }

          let currPrefixUnfinishedList = []
          // 没有前缀代表在根目录，过滤掉所有
          if (!this.Prefix) {
            currPrefixUnfinishedList = data.Upload.filter(item => !item.Key.includes('/'));
          } else {
            currPrefixUnfinishedList = data.Upload.filter(item => item.Key.startsWith(this.Prefix));
          }

          for (const unfinishedItem of currPrefixUnfinishedList) {
            const blob = await localforage.getItem(unfinishedItem.Key);
            if (blob) {
              unfinishedItem.file = new File([blob], unfinishedItem.Key);
            }
          }

          this.currPrefixUnfinishedList = currPrefixUnfinishedList;
        });
      },
      // 上传文件
      uploadFileClick() {
        document.querySelectorAll('.file-select')[0].click();
      },
      // 上传文件夹
      uploadFolderClick() {
        document.querySelectorAll('.folder-select')[0].click();
      },
      breakpointUpload(unfinishedItem) {
        const { file, Key } = unfinishedItem;
        const uploadFileList = [
          {
            Bucket,
            Region,
            Key: Key,
            Body: file,
          }
        ]
        this.cosUpload(uploadFileList)
      },
      // 删除本地和服务器上的碎片文件
      async deleteLocalAndRemoteSlice(unfinishedItem) {
        cos.multipartAbort({
          Bucket: Bucket, /* 填入您自己的存储桶，必须字段 */
          Region: Region,  /* 存储桶所在地域，例如ap-beijing，必须字段 */
          Key: unfinishedItem.Key,  /* 存储在桶里的对象键（例如1.jpg，a/b/test.txt），必须字段 */
          UploadId: unfinishedItem.UploadId    /* 必须 */
        }, (err, data) => {
          if (err) {
            return console.log(err)
          }
          this.getCurrPrefixUnfinishedList()
          console.log(data);
        });
        await this.deleteLocalSlice(unfinishedItem.Key)
      },
      async deleteLocalSlice(key) {
        await localforage.removeItem(key);
      },
      // 上传
      uploadChange(events) {
        const files = events.currentTarget.files;

        const uploadFileList = [...files].map((file) => {
          const path = file.webkitRelativePath || file.name;
          return {
            Bucket,
            Region,
            Key: this.Prefix + path,
            Body: file,
          }
        });

        const singleFileInfo = uploadFileList[0]
        this.saveFileToLocal(singleFileInfo.Key, singleFileInfo.Body)

        this.uploadingInfo.prefix = this.Prefix

        
        this.cosUpload(uploadFileList)

      },
      // 将文件存储到本地以用于断点续传
      saveFileToLocal(key, file) {
        const blob = new Blob([file])
        localforage.setItem(key, blob)
      },
      cosUpload(uploadFileList) {
        const startTime = Date.now()

        cos.dynamicChunkParallel = 3; // 默认配置
        let sliceSize = 1024 * 1024 * 1 // 默认配置
        if (this.uploadConfig === 'dynamic') {
          // 假设网络良好
          sliceSize = 1024 * 1024 * 10
        }

        cos.uploadFiles({
          files: uploadFileList,
          SliceSize: sliceSize, // 传入参数 SliceSize 可以控制文件大小超出一个数值（默认1MB）时自动使用分块上传
          onProgress: (info) => {
            console.log('onProgress', info)

            if (this.uploadConfig === 'dynamic') {
              if (cos.dynamicChunkParallel < 16) {
                cos.dynamicChunkParallel += 1;
              }
            }

            // loaded 字节 byte = 8 bits，1024 byte = 1 KB，1024 KB = 1 MB，1024 MB = 1 GB
            // 中国大陆单个存储桶上行和下行共享带宽为 15Gbit/s => 15 / 8 = 2.5 GB/s
            // 简单上传：单个对象最大5GB，详情请参见 https://cloud.tencent.com/document/product/436/14113
            // 分块上传：单个对象最大48.82TB，块大小1MB - 5GB，最后一个块可小于1MB，分块数1 - 10000 https://cloud.tencent.com/document/product/436/14112

            // 大文件上传过程失败更换签名继续上传？https://cloud.tencent.com/document/product/436/30740

            this.isUploding = true
            const lastTimeSecond = (Date.now() - startTime) / 1000;

            this.uploadingInfo.name = uploadFileList[0].Key
            this.uploadingInfo.fileSize = (info.total / 1024 / 1024).toFixed(2) + 'Mb'
            this.uploadingInfo.percent = parseInt(info.percent * 10000) / 100 + '%' // 进度
            this.uploadingInfo.speed = parseInt(info.speed / 1024 / 1024 * 100) / 100 + 'Mb/s' // 速度
            this.uploadingInfo.lastTime = lastTimeSecond.toFixed(1) + 's' // 持续时间              
            this.uploadingInfo.avgSpeed = ((info.loaded / 1024 / 1024) / lastTimeSecond).toFixed(1) + 'Mb/s' // 平均速度

          },
          onFileFinish: (err, data, options) => {
            console.log(options.Key + '上传' + (err ? '失败' : '完成'));
            this.deleteLocalSlice(uploadFileList[0].Key)
            this.getCurrPrefixUnfinishedList()
          },
        }, (err, data) => {
          if (err) {
            return console.log('上传失败', err);
          }
          // 刷新列表前初始化
          this.hasMore = false;
          this.Marker = '';
          this.getFileList();
        });
      },
      // 加载更多
      loadMore() {
        this.getFileList(true);
      },
      // 下载
      downloadFile(file) {
        cos.getObjectUrl({
          Bucket, /* 必须 */
          Region,     /* 存储桶所在地域，必须字段 */
          Key: file.Key,              /* 必须 */
        }, function (err, data) {
          if (err) {
            console.log(err);
            return;
          }
          const url = data.Url + (data.Url.indexOf('?') > -1 ? '&' : '?') + 'response-content-disposition=attachment'; // 补充强制下载的参数
          // 使用iframe下载
          const elemIF = document.createElement("iframe");
          elemIF.src = url;
          elemIF.style.display = "none";
          document.body.appendChild(elemIF);
        });
      },
      // 删除
      deleteFile(file) {
        cos.deleteObject({
          Bucket, /* 必须 */
          Region,     /* 存储桶所在地域，必须字段 */
          Key: file.Key        /* 必须 */
        }, (err, data) => {
          if (err) {
            console.log(err);
            return;
          }
          // 刷新列表前初始化
          this.hasMore = false;
          this.Marker = '';
          this.getFileList();
        });
      },
      getDownloadSpeed() {
        return new Promise((resolve, reject) => {
          requestIdleCallback(() => {
            const fileSrc = '//cdn-1257430323.cos.ap-guangzhou.myqcloud.com/assets/imgs/1920-960.png';
            const fileSize = 3.88;
      
            const testImg = new Image();
            testImg.src = fileSrc;
            const st = Date.now();
            testImg.onload = showSpeed;
      
            function showSpeed() {
              const _fileSize = fileSize; // measured in MB
              const et = Date.now();
              const speed = Math.round(_fileSize) / ((et - st) / 1000);
              resolve(speed.toFixed(1));
            }
          });
        });
      }
    },
  });
}
